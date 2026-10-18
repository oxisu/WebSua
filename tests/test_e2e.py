"""端到端测试：扫描 → 索引 → Range 流转发 → 进度/收藏。"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# 项目根目录自动推导 —— 不写死任何本机绝对路径
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

B = "http://127.0.0.1:8792"
DAV = "http://127.0.0.1:8898/dav"
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))

PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {label}" + (f"  {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {label}  {detail}")


def req(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(B + path, data=data, method=method,
                               headers={"Content-Type": "application/json"} if data else {})
    try:
        with op.open(r, timeout=40) as resp:
            return resp.status, json.loads(resp.read() or b"{}"), resp.headers
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), e.headers


def q(path, **params):
    """构造带正确 URL 编码的查询串（中文搜索词必须编码）。"""
    parts = []
    for k, v in params.items():
        if v is None or v == "":
            continue
        parts.append(f"{k}={urllib.parse.quote(str(v), safe=',')}")
    return path + ("?" + "&".join(parts) if parts else "")


def raw(path, headers=None):
    r = urllib.request.Request(B + path, headers=headers or {})
    try:
        resp = op.open(r, timeout=40)
        return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


print("=" * 62)
print("1. 建立数据源并扫描")
print("=" * 62)
# 清掉旧数据
_, d, _ = req("/api/sources")
for s in d["sources"]:
    req(f"/api/sources/{s['id']}", "DELETE")

st, d, _ = req("/api/sources", "POST",
               {"name": "本地测试", "base_url": "127.0.0.1:8898/dav",
                "root_path": "/", "color": "#6C8CFF"})
sid = d["id"]
check("创建数据源", st == 200 and sid > 0, f"id={sid}")

st, p, _ = req(f"/api/sources/{sid}/probe", "POST",
               {"base_url": DAV, "root_path": "/"})
check("连接测试", st == 200, f"条目={p.get('total')} 子目录={p.get('folders')}")

st, t, _ = req(f"/api/sources/{sid}/scan", "POST")
tid = t["task"]["id"]
for _ in range(40):
    time.sleep(0.3)
    st, t, _ = req(f"/api/tasks/{tid}")
    if t["task"]["state"] in ("done", "failed"):
        break
task = t["task"]
check("扫描完成", task["state"] == "done",
      f"发现={task.get('found')} 总数={task.get('total')} 耗时={task.get('elapsed_ms')}ms")
if task["state"] == "failed":
    print("     错误:", task.get("error"))

print()
print("=" * 62)
print("2. 媒体库索引")
print("=" * 62)
st, m, _ = req("/api/media?limit=50")
check("索引到文件", m["total"] >= 8, f"总数={m['total']}")
kinds = {}
for x in m["media"]:
    kinds[x["kind"]] = kinds.get(x["kind"], 0) + 1
check("识别视频", kinds.get("video", 0) >= 5, f"video={kinds.get('video', 0)}")
check("识别图片", kinds.get("image", 0) >= 2, f"image={kinds.get('image', 0)}")
check("识别音频", kinds.get("audio", 0) >= 1, f"audio={kinds.get('audio', 0)}")
cn = [x for x in m["media"] if any(c > '\x7f' for c in x["name"])]
check("中文名解析正确", len(cn) >= 4, f"{[x['name'] for x in cn[:4]]}")
sp = [x for x in m["media"] if " " in x["name"]]
check("空格名解析正确", len(sp) >= 2, f"{[x['name'] for x in sp[:3]]}")
nested = [x for x in m["media"] if x["folder"].count("/") >= 2]
check("嵌套目录", len(nested) >= 1, f"{[x['folder'] for x in nested[:2]]}")

print()
print("=" * 62)
print("3. Range 流转发（拖动进度条的关键）")
print("=" * 62)
vid = next((x for x in m["media"] if x["kind"] == "video"), None)
check("找到视频条目", vid is not None, vid["name"] if vid else "")

if vid:
    total = vid["size"]
    print(f"  文件大小 = {total}")

    st, h, body = raw(f"/api/stream/{vid['id']}")
    check("全量 200", st == 200 and len(body) == total, f"收到 {len(body)}/{total}")
    check("Accept-Ranges 头", h.get("Accept-Ranges") == "bytes")
    check("Content-Type 正确", "video" in h.get("Content-Type", ""), h.get("Content-Type"))

    st, h, body = raw(f"/api/stream/{vid['id']}", {"Range": "bytes=0-1023"})
    check("Range 206", st == 206, f"状态={st}")
    check("Content-Range 正确", h.get("Content-Range") == f"bytes 0-1023/{total}",
          h.get("Content-Range"))
    check("分段长度正确", len(body) == 1024, f"收到 {len(body)}")
    check("分段内容与全量一致", body == raw(f"/api/stream/{vid['id']}")[2][:1024])

    mid = total // 2
    st, h, body = raw(f"/api/stream/{vid['id']}", {"Range": f"bytes={mid}-"})
    exp = total - mid
    check("中段 Range", st == 206 and len(body) == exp,
          f"bytes={mid}- 收到 {len(body)}，期望 {exp}")
    check("中段 Content-Range", h.get("Content-Range") == f"bytes {mid}-{total-1}/{total}")

    st, h, body = raw(f"/api/stream/{vid['id']}", {"Range": "bytes=-500"})
    check("尾部 Range (后500字节)", st == 206 and len(body) == 500, f"收到 {len(body)}")

    st, h, body = raw(f"/api/stream/{vid['id']}", {"Range": f"bytes={total + 100}-"})
    check("越界返回 416", st == 416, f"状态={st} CR={h.get('Content-Range')}")

    # 模拟连续拖动：多次 Range 应各自正确
    ok = True
    for off in (0, total // 4, total // 2, total - 1000):
        st, h, body = raw(f"/api/stream/{vid['id']}", {"Range": f"bytes={off}-{off+999}"})
        if not (st == 206 and len(body) == 1000):
            ok = False
    check("连续拖动 4 次全部正确", ok)

    st, h, body = raw(f"/api/proxy/{vid['id']}")
    check("备用端点 /api/proxy", st == 200 and len(body) == total, f"收到 {len(body)}")

print()
print("=" * 62)
print("4. 进度与收藏")
print("=" * 62)
if vid:
    st, _, _ = req("/api/progress", "POST",
                   {"media_id": vid["id"], "position": 12.5, "duration": 200})
    check("保存进度", st == 200)
    st, pr, _ = req("/api/progress")
    check("进度已回读", str(vid["id"]) in pr["progress"],
          f"position={pr['progress'].get(str(vid['id']))}")

    st, f1, _ = req(f"/api/media/{vid['id']}/fav", "POST")
    check("收藏", st == 200 and f1["favorite"] is True)
    st, f2, _ = req(f"/api/media/{vid['id']}/fav", "POST")
    check("取消收藏", f2["favorite"] is False)

    st, info, _ = req(f"/api/media/{vid['id']}")
    check("媒体详情接口", st == 200 and info.get("file_name"),
          f"{info.get('file_name')} / {info.get('file_size_str')}")

    st, batch, _ = req("/api/progress-batch", "POST",
                       {"entries": [{"media_id": vid["id"], "position": 30, "duration": 200}]})
    check("批量上报进度", st == 200 and batch["saved"] == 1)

print()
print("=" * 62)
print("5. 筛选与分页")
print("=" * 62)
st, v, _ = req("/api/media?kinds=video&limit=5")
check("按类型筛选", all(x["kind"] == "video" for x in v["media"]), f"{v['total']} 个视频")
st, s1, _ = req(f"/api/media?sources={sid}&kinds=video&limit=3&offset=0")
st, s2, _ = req(f"/api/media?sources={sid}&kinds=video&limit=3&offset=3")
ids1 = {x["id"] for x in s1["media"]}
ids2 = {x["id"] for x in s2["media"]}
check("分页不重复", not (ids1 & ids2) if ids1 and ids2 else True)
st, sr, _ = req(q("/api/media", q="动画"))
check("中文搜索", sr["total"] >= 3, f"匹配 {sr['total']} 个")
st, fo, _ = req("/api/folders")
check("目录列表", len(fo["sources"]) >= 1 and len(fo["sources"][0]["folders"]) >= 1,
      f"{len(fo['sources'][0]['folders'])} 个目录")

print()
print("=" * 62)
print("6. 错误处理")
print("=" * 62)
st, e, _ = req("/api/stream/999999")
check("不存在的媒体流返回 JSON 错误", st == 404 and e.get("ok") is False, str(e)[:50])
st, e, _ = req("/api/media/999999")
check("不存在的媒体详情", st == 404)

print()
print("=" * 62)
print(f"结果：{PASS} 通过 / {FAIL} 失败")
print("=" * 62)
sys.exit(1 if FAIL else 0)
