import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from travel.answers import rag_answer
from travel.config import ROOT, Settings
from travel.knowledge import INTERESTS, REGIONS, dataset, get_place, places, search
from travel.mcp_client import ToolError, amap_search, local_call

# 避免外部 HTTP 日志把带 key 的高德 URL 打印出来。
logging.getLogger('httpx').setLevel(logging.WARNING)
logging.getLogger('httpcore').setLevel(logging.WARNING)

@asynccontextmanager
async def lifespan(app):
    # 先验证资料再启动服务，损坏的资料不会在用户点击后才变成不明 500。
    dataset()
    yield


app = FastAPI(title='港慢游 · Hong Kong Travel Assistant', version='1.1.0', docs_url=None, redoc_url=None, lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost', '[::1]', 'testserver'])
app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')
settings = Settings.from_env()
# 单机演示：限制同时启动的 MCP 子进程数，避免连续点击堆积。
semaphore = asyncio.Semaphore(4)


@app.middleware('http')
async def local_origin_only(request: Request, call_next):
    if request.method in ['POST', 'PUT', 'DELETE', 'PATCH']:
        origin = request.headers.get('origin')
        if origin and origin != f'{request.url.scheme}://{request.headers.get("host")}':
            return JSONResponse({'detail': '只接受本地页面的请求。'}, status_code=403)
        length = request.headers.get('content-length', '0')
        if not length.isdigit() or int(length) > 20_000:
            return JSONResponse({'detail': '请求过大。'}, status_code=413)
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    return response


class AskRequest(BaseModel):
    question: str = Field(min_length=2, max_length=500)
    region: Literal['全部', '香港岛', '九龙', '大屿山'] = '全部'
    indoor_only: bool = False
    use_model: bool = False


class PlanRequest(BaseModel):
    days: int = Field(default=2, ge=1, le=3)
    region: Literal['全部', '香港岛', '九龙', '大屿山'] = '全部'
    interests: list[str] = Field(default_factory=lambda: ['海港夜景', '本地美食'], max_length=7)
    pace: Literal['轻松', '充实'] = '轻松'
    rain: bool = False
    public_only: bool = False
    must_visit: list[str] = Field(default_factory=list, max_length=3)


class AmapRequest(BaseModel):
    place_id: str = Field(min_length=1, max_length=80)


@app.get('/')
def index():
    return FileResponse(ROOT / 'static' / 'index.html')


@app.get('/api/status')
def status():
    return {'name': '港慢游', 'version': app.version, 'knowledge_version': dataset()['version'],
            'place_count': len(places()), 'model_configured': bool(settings.model_api_key),
            'amap_configured': bool(settings.amap_api_key), 'local_mcp': 'stdio',
            'interests': INTERESTS, 'regions': REGIONS, 'data_note': dataset()['editorial_note']}


@app.get('/api/places')
def list_places(q: str = '', region: Literal['全部', '香港岛', '九龙', '大屿山'] = '全部'):
    if len(q) > 500:
        raise HTTPException(422, '搜索词过长。')
    found = search(q, 10, region) if q.strip() else [p for p in places() if region == '全部' or p['region'] == region]
    return {'places': found}


@app.post('/api/ask')
async def ask(body: AskRequest):
    question = body.question.strip()
    if len(question) < 2:
        raise HTTPException(422, '请输入至少两个字的问题。')
    q = question
    indoor = body.indoor_only or any(s in q for s in ['雨天', '下雨', '室内', '室內'])
    food_only = any(s in q for s in ['吃什么', '吃什麼', '吃饭', '美食', '小吃', '餐厅']) and not any(s in q for s in ['景点', '景點', '游玩'])
    try:
        async with semaphore:
            data, trace = await local_call('search_places', {'query': q, 'limit': 5, 'region': body.region,
                                                           'indoor_only': indoor, 'kind': 'food' if food_only else 'all'})
        hits = data['results']
        # 默认本地演示。即便填了 key，也由用户主动开启模型回答。
        chosen = settings if body.use_model else Settings()
        answer = await rag_answer(q, hits, chosen)
        if body.use_model and not settings.model_api_key:
            answer['notice'] = '未配置模型 Key，本次使用本地资料摘录。'
        cited = [p for p in hits if p['id'] in answer['citations']]
        return {'answer': answer, 'sources': cited, 'retrieved': hits, 'trace': [trace]}
    except Exception:
        raise HTTPException(503, '本地资料工具暂时不可用，请重试；若持续失败，请查看终端并重新启动。')


@app.post('/api/plan')
async def make_plan(body: PlanRequest):
    try:
        async with semaphore:
            data, trace = await local_call('plan_itinerary', body.model_dump())
        return {**data, 'trace': [trace]}
    except ToolError as exc:
        # SDK 工具校验失败，供用户调整条件。仅本地工具错误可这样返回。
        raise HTTPException(422, str(exc))
    except TimeoutError:
        raise HTTPException(503, '规划工具超时，请稍后重试。')
    except Exception:
        raise HTTPException(503, '规划工具暂不可用，请检查本地服务后重试。')


@app.post('/api/amap/search')
async def search_amap(body: AmapRequest):
    try:
        p = get_place(body.place_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    async with semaphore:
        return await amap_search('香港 ' + p['name'], settings)
