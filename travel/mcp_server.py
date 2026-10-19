"""真正的 MCP stdio 服务。stdout 只留给协议，日志由 SDK 写入 stderr。"""
from mcp.server.fastmcp import FastMCP

from .knowledge import get_place, search
from .planner import estimate_transfer, plan

mcp = FastMCP('Hong Kong Travel Tools', log_level='ERROR')


@mcp.tool()
def search_places(query: str, limit: int = 5, region: str = '全部',
                  indoor_only: bool = False, kind: str = 'all') -> dict:
    """检索本地香港官方资料摘要，返回地点、匹配依据和来源。不是实时搜索。"""
    return {'results': search(query, limit, region, indoor_only, kind), 'source': 'curated_local_knowledge'}


@mcp.tool()
def place_detail(place_id: str) -> dict:
    """读取指定地点的介绍、来源与参观提示。"""
    return get_place(place_id)


@mcp.tool()
def transfer_estimate(origin_id: str, destination_id: str) -> dict:
    """根据人工近似坐标给交通余量，不是实时路线。"""
    return estimate_transfer(origin_id, destination_id)


@mcp.tool()
def plan_itinerary(days: int = 2, region: str = '全部', interests: list[str] | None = None,
                   pace: str = '轻松', rain: bool = False, public_only: bool = False,
                   must_visit: list[str] | None = None) -> dict:
    """根据天数、区域、兴趣与必去地点安排可解释的香港行程草案。"""
    return plan(days, region, interests, pace, rain, public_only, must_visit)


if __name__ == '__main__':
    mcp.run(transport='stdio')
