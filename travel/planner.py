"""约束筛选 + 按街区分组 + 近邻排序。所有时长均为规划假设。"""
import math

from .knowledge import INTERESTS, REGIONS, get_place, places


def km_between(a, b):
    lat1, lat2 = math.radians(a['lat']), math.radians(b['lat'])
    dlat = lat2-lat1
    dlon = math.radians(b['lon']-a['lon'])
    h = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    return 6371 * 2 * math.asin(min(1, math.sqrt(h)))


def estimate_transfer(origin_id: str, destination_id: str) -> dict:
    a, b = get_place(origin_id), get_place(destination_id)
    km = km_between(a, b)
    # 昂坪—大澳虽直线接近，山路绕行明显，不能用城区步行公式。
    mountain = a['region'] == b['region'] == '大屿山' and a['area'] != b['area']
    hill = 'peak' in [a['id'], b['id']]
    if mountain:
        mode, mins = '山区交通待查', 70
    elif hill:
        mode, mins = '上／下山交通待查', 60
    elif km < 1.0:
        mode, mins = '步行估算', max(10, math.ceil(km * 1.5 / 4 * 60) + 5)
    else:
        mode, mins = '公共交通估算', max(25, math.ceil(km * 1.6 / 18 * 60) + 20)
    return {'origin_id': origin_id, 'destination_id': destination_id,
            'straight_km': round(km, 2), 'minutes': mins, 'mode': mode,
            'basis': '人工近似坐标、直线距离与固定余量；不是导航路线或实时班次',
            'live': False}


def _time(minutes):
    return f'{minutes // 60:02}:{minutes % 60:02}'


def plan(days=2, region='全部', interests=None, pace='轻松', rain=False,
         public_only=False, must_visit=None) -> dict:
    interests = ['海港夜景', '本地美食'] if interests is None else interests
    must_visit = list(dict.fromkeys(must_visit or []))
    if not 1 <= days <= 3 or region not in REGIONS or pace not in ['轻松', '充实']:
        raise ValueError('请使用 1–3 天、有效地区和游览节奏。')
    if any(t not in INTERESTS for t in interests):
        raise ValueError('发现未知兴趣，请从页面选项选择。')
    if len(must_visit) > 3:
        raise ValueError('最多选择 3 个必去地点。')
    required = [get_place(pid) for pid in must_visit]

    def allowed(p):
        return ((region == '全部' or p['region'] == region)
                and (not rain or p['indoor'])
                and (not public_only or p['cost'] == 'public' or p['kind'] == 'food'))

    conflicts = [p['name'] for p in required if not allowed(p)]
    if conflicts:
        raise ValueError('必去地点与当前地区、室内或公共空间条件冲突：' + '、'.join(conflicts) + '。请调整条件。')
    pool = [p for p in places() if allowed(p)]
    if not any(p['kind'] == 'attraction' for p in pool):
        raise ValueError('当前条件下没有可安排的景点资料。可取消“只选室内”、公共空间限制或扩大地区。')
    max_stops = 3 if pace == '轻松' else 4

    def score(p):
        return p['priority'] + 5 * len(set(p['tags']) & set(interests))

    # 每天围绕一个街区组合；必去地点优先，避免把大屿山塞进市区半天。
    groups = {}
    for p in pool:
        groups.setdefault(p['cluster'], []).append(p)
    required_groups = list(dict.fromkeys(p['cluster'] for p in required))
    if len(required_groups) > days:
        raise ValueError('必去地点分散在多个街区，当前天数不足。请增加天数或减少必去地点。')
    group_order = required_groups + sorted((g for g in groups if g not in required_groups),
                        key=lambda g: -sum(sorted([score(p) for p in groups[g] if p['kind'] == 'attraction'], reverse=True)[:3]))
    used = set()
    result, warnings = [], []
    for day in range(days):
        group = next((g for g in group_order if any(p['id'] not in used and p['kind'] == 'attraction' for p in groups[g])), None)
        if group is None:
            warnings.append('现有资料无法排满全部天数，已保留空闲日；可扩大地区或补充地点。')
            break
        candidates = [p for p in groups[group] if p['id'] not in used]
        essential = [p for p in candidates if p['id'] in must_visit]
        attraction = sorted([p for p in candidates if p['kind'] == 'attraction' and p not in essential], key=lambda p: -score(p))
        chosen = essential + attraction[:max(0, max_stops-len(essential))]
        foods = sorted([p for p in candidates if p['kind'] == 'food' and p not in chosen], key=lambda p: -score(p))
        if foods:
            chosen.append(foods[0])
        # 公园／展览先游；晚餐食店和庙街延后。顺序是启发式，不是最优路线证明。
        night = [p for p in chosen if p['id'] in ['temple-street', 'hing-kee', 'peak']]
        visit = [p for p in chosen if p['kind'] == 'attraction' and p not in night]
        ordered = []
        while visit:
            anchor = ordered[-1] if ordered else max(visit, key=score)
            nxt = min(visit, key=lambda p: km_between(anchor, p))
            ordered.append(nxt)
            visit.remove(nxt)
        regular_food = [p for p in chosen if p['kind'] == 'food' and p not in night]
        for p in regular_food:
            ordered.insert(min(1, len(ordered)), p)
        ordered += night
        current, stops, legs = (13*60 if group == 'local' else 10*60), [], []
        for i, p in enumerate(ordered):
            if i:
                leg = estimate_transfer(ordered[i-1]['id'], p['id'])
                legs.append(leg)
                current += leg['minutes']
            before_slot = current
            if p['id'] in ['temple-street', 'hing-kee', 'peak']:
                current = max(current, 17*60 if p['id'] != 'hing-kee' else 18*60)
            free_minutes = current - before_slot
            start = current
            current += p['duration']
            stops.append({'place': p, 'start': _time(start), 'end': _time(current), 'minutes': p['duration'],
                          'free_before_minutes': free_minutes})
            used.add(p['id'])
        label = {'central':'中环与山顶', 'harbour':'尖沙咀与西九', 'local':'街区与港式味道', 'garden':'园林与传统文化', 'lantau':'昂坪与大澳'}[group]
        result.append({'day': day+1, 'title': label, 'stops': stops, 'legs': legs,
                       'transfer_minutes': sum(x['minutes'] for x in legs), 'end': _time(current),
                       'meal_note': '餐饮候选不包含订位，其他正餐请自行安排。' if any(p['kind'] == 'food' for p in ordered) else '这个街区的餐饮资料不足，请自行安排午餐与晚餐。'})
        # 用过的组若仍有足够地点，可用于后续同地区游览。
        group_order.remove(group)
        group_order.append(group)
    scheduled = {stop['place']['id'] for d in result for stop in d['stops']}
    if not set(must_visit) <= scheduled:
        raise ValueError('现有规划容量无法容纳全部必去地点，请增加天数或减少必去地点。')
    warnings += ['时间表是可调整草案，未核验开放日、实时天气、票务和交通；出发前请核对各地点官网。',
                 '交通分钟数为本地估算，不含酒店往返，也不是高德导航结果。',
                 '未计算酒店、机票、门票和餐饮总费用，不能据此宣称满足总预算。']
    if rain:
        warnings.append('“只选室内”按资料标签筛选，不代表全天避雨；跨地点移动仍需户外交通。')
    if public_only:
        warnings.append('公共空间优先会排除门票／混合收费景点；用餐与交通仍需付费。')
    return {'days_requested': days, 'days': result, 'warnings': warnings,
            'algorithm': '条件筛选 → 街区分组 → 兴趣评分 → 近邻排序 → 停留与交通余量',
            'live_routes': False}
