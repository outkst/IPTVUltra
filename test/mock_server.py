"""Mock Xtream Codes server + static host for the IPTV Ultra app.

Serves the app from C:/repos/IPTVUltra/IPTVUltra at / and a fake
player_api.php at /player_api.php on the same origin (no CORS issues).
Counts get_short_epg requests so lazy loading can be verified at /__stats.
"""
import http.server, json, time, urllib.parse, os, sys, threading

APP_DIR = r'C:\repos\IPTVUltra\IPTVUltra'
N_CHANNELS = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
PORT = 8765
stats = {'epg_requests': 0, 'epg_stream_ids': [], 'live_streams': 0}
lock = threading.Lock()

CATS = [{'category_id': str(i), 'category_name': f'Group {i:02d}'} for i in range(1, 31)]
STREAMS = [{
    'num': i, 'name': f'Channel {i:05d}', 'stream_type': 'live', 'stream_id': i,
    'stream_icon': '', 'epg_channel_id': f'ch{i}.test' if i % 7 else '',
    'category_id': str((i % 30) + 1), 'tv_archive': 1 if i % 50 == 0 else 0, 'tv_archive_duration': 3 if i % 50 == 0 else 0,
} for i in range(1, N_CHANNELS + 1)]  # every 50th channel offers a 3-day catch-up archive

def simple_data_table(stream_id):
    # Full table: 48 h of history plus the same future as the short EPG, half-hour slots, has_archive on past items
    import base64
    now = int(time.time())
    first = now - (now % 1800) - 48 * 3600
    out = []
    k = 0
    for s in range(first, now + 6 * 3600, 1800):
        out.append({
            'id': f'{stream_id}-full-{k}', 'epg_id': '1', 'lang': '',
            'title': base64.b64encode(f'Show {stream_id}-{k}'.encode()).decode(),
            'description': base64.b64encode(f'Description for show {k} on channel {stream_id}'.encode()).decode(),
            'start': time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(s)), 'end': time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(s + 1800)),
            'channel_id': f'ch{stream_id}.test', 'start_timestamp': str(s), 'stop_timestamp': str(s + 1800),
            'now_playing': 1 if s <= now < s + 1800 else 0, 'has_archive': 1 if s + 1800 <= now else 0,
        })
        k += 1
    return {'epg_listings': out}

def short_epg(stream_id, limit):
    now = int(time.time())
    start = now - (now % 1800) - 1800  # one slot of history
    out = []
    for k in range(limit):
        s = start + k * 1800
        out.append({
            'id': f'{stream_id}-{k}', 'epg_id': '1', 'title': '', 'lang': '',
            'start': time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(s)),
            'end': time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(s + 1800)),
            'description': '', 'channel_id': f'ch{stream_id}.test',
            'start_timestamp': str(s), 'stop_timestamp': str(s + 1800),
        })
        import base64
        out[-1]['title'] = base64.b64encode(f'Show {stream_id}-{k}'.encode()).decode()
        out[-1]['description'] = base64.b64encode(f'Description for show {k} on channel {stream_id}'.encode()).decode()
    return {'epg_listings': out}

# ---- VOD / series fixtures ----
VOD_CATS = [{'category_id': str(100 + i), 'category_name': n} for i, n in enumerate(['Action', 'Comedy', 'Drama', 'Kids', '4K Movies', 'Adult XXX'])]
VOD = []
for _ci, _c in enumerate(VOD_CATS):
    for _j in range(60):
        VOD.append({'num': _j, 'name': f"{_c['category_name']} Movie {_j + 1:02d}", 'stream_type': 'movie', 'stream_id': 5000 + _ci * 100 + _j,
                    'stream_icon': '', 'rating': f"{5 + (_j % 5)}.{_j % 10}", 'rating_5based': 3, 'added': str(1700000000 + _ci * 86400 + _j * 3600),
                    'category_id': _c['category_id'], 'container_extension': 'mp4', 'genre': 'Thriller, Crime' if _j % 3 == 0 else 'Family', 'year': str(1990 + _j % 30)})
SERIES_CATS = [{'category_id': str(200 + i), 'category_name': n} for i, n in enumerate(['Drama Series', 'Comedy Series', 'Adult Series'])]
SERIES = []
for _ci, _c in enumerate(SERIES_CATS):
    for _j in range(20):
        SERIES.append({'num': _j, 'name': f"{_c['category_name']} Show {_j + 1:02d}", 'series_id': 7000 + _ci * 100 + _j, 'cover': '',
                       'plot': f'Plot of show {_j + 1}.', 'cast': 'A. Actor, B. Actor', 'director': 'D. Director', 'genre': 'Drama',
                       'releaseDate': '2021-03-01', 'last_modified': str(1700000000 + _ci * 86400 + _j * 3600), 'rating': '8.1', 'rating_5based': 4,
                       'backdrop_path': [], 'youtube_trailer': '', 'episode_run_time': '45', 'category_id': _c['category_id']})
CLIP = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'clip.mp4')

def series_info(sid):
    eps = {}
    for season in (1, 2):
        eps[str(season)] = [{'id': str(80000 + sid * 10 + season * 3 + e), 'episode_num': e, 'title': f'S{season} E{e} Title', 'container_extension': 'mp4',
                             'info': {'duration': '00:00:20', 'duration_secs': 20, 'plot': f'Episode {e} of season {season}.', 'movie_image': ''}, 'season': season}
                            for e in range(1, 4 if season == 1 else 3)]
    return {'seasons': [], 'info': {'name': f'Show {sid}', 'plot': 'Series plot.', 'cast': 'A. Actor', 'director': 'D. Director', 'genre': 'Drama',
                                     'releaseDate': '2021-03-01', 'rating': '8.1', 'backdrop_path': [], 'cover': ''}, 'episodes': eps}

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=APP_DIR, **kw)
    def log_message(self, *a):
        pass
    def send_json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def send_clip(self):
        data = open(CLIP, 'rb').read()
        rng = self.headers.get('Range')
        start, end = 0, len(data) - 1
        if rng and rng.startswith('bytes='):
            a, _, b = rng[6:].partition('-')
            if a: start = int(a)
            if b: end = min(int(b), len(data) - 1)
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {start}-{end}/{len(data)}')
        else:
            self.send_response(200)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Type', 'video/mp4')
        self.send_header('Content-Length', str(end - start + 1))
        self.end_headers()
        self.wfile.write(data[start:end + 1])

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path.startswith('/timeshift/'):
            with lock:
                stats['timeshift_requests'] = stats.get('timeshift_requests', 0) + 1
                stats['last_timeshift'] = u.path
            return self.send_clip()
        if u.path.startswith('/hls50/'):  # 6 s HLS clip, 50 fps, no FRAME-RATE in the playlist (like the provider's)
            name = os.path.basename(u.path)
            path = os.path.join(os.path.dirname(CLIP), 'hls50', name)
            if not os.path.isfile(path):
                self.send_response(404); self.end_headers(); return
            data = open(path, 'rb').read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/vnd.apple.mpegurl' if name.endswith('.m3u8') else 'video/mp2t')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if u.path.startswith('/movie/') or u.path.startswith('/series/'):
            with lock:
                stats['media_requests'] = stats.get('media_requests', 0) + 1
                stats['last_media'] = u.path
            return self.send_clip()
        if u.path == '/__stats':
            with lock:
                return self.send_json(stats)
        if u.path == '/__cons':
            with lock: stats['cons'] = {'active': int(q.get('active', ['0'])[0]), 'max': int(q.get('max', ['1'])[0])}
            return self.send_json({'ok': True})
        if u.path == '/__reset':
            with lock:
                stats['epg_requests'] = 0; stats['epg_stream_ids'] = []
                stats['vod_requests'] = 0; stats['vod_actions'] = []; stats['media_requests'] = 0
                stats['timeshift_requests'] = 0; stats['full_epg_requests'] = 0
            return self.send_json({'ok': True})
        if u.path == '/player_api.php':
            if q.get('username', [''])[0] != 'user' or q.get('password', [''])[0] != 'pass':
                return self.send_json({'user_info': {'auth': 0}})
            action = q.get('action', [''])[0]
            if action == '':
                with lock: cons = dict(stats.get('cons', {'active': 0, 'max': 1}))
                return self.send_json({'user_info': {'auth': 1, 'username': 'user', 'status': 'Active', 'active_cons': str(cons['active']), 'max_connections': str(cons['max'])}, 'server_info': {'timezone': 'Europe/Amsterdam'}})
            if action == 'get_live_categories':
                return self.send_json(CATS)
            if action == 'get_live_streams':
                with lock: stats['live_streams'] += 1
                return self.send_json(STREAMS)
            if action in ('get_vod_categories', 'get_vod_streams', 'get_vod_info', 'get_series_categories', 'get_series', 'get_series_info'):
                with lock:
                    stats['vod_requests'] = stats.get('vod_requests', 0) + 1
                    stats.setdefault('vod_actions', []).append(action + ('@' + q['category_id'][0] if 'category_id' in q else ''))
                cid = q.get('category_id', [None])[0]
                if action == 'get_vod_categories': return self.send_json(VOD_CATS)
                if action == 'get_series_categories': return self.send_json(SERIES_CATS)
                if action == 'get_vod_streams': return self.send_json([v for v in VOD if cid is None or v['category_id'] == cid])
                if action == 'get_series': return self.send_json([v for v in SERIES if cid is None or v['category_id'] == cid])
                if action == 'get_vod_info':
                    vid = int(q.get('vod_id', ['0'])[0])
                    v = next((x for x in VOD if x['stream_id'] == vid), None)
                    if not v: return self.send_json({})
                    return self.send_json({'info': {'movie_image': '', 'plot': f"Plot of {v['name']}.", 'cast': 'A. Actor, B. Actor', 'director': 'D. Director',
                                                    'genre': 'Action', 'releasedate': '2023-05-01', 'duration': '00:00:20', 'duration_secs': 20, 'rating': v['rating'], 'backdrop_path': [],
                                                    'tmdb_id': '123', 'age': 'PG-13', 'country': 'USA', 'youtube_trailer': 'abc123', 'bitrate': 5000000,
                                                    'video': {'width': 1920, 'height': 1080, 'codec_name': 'h264', 'r_frame_rate': '24000/1001'}, 'audio': {'codec_name': 'aac', 'channels': 6}},
                                           'movie_data': {'stream_id': vid, 'name': v['name'], 'container_extension': 'mp4', 'category_id': v['category_id']}})
                if action == 'get_series_info':
                    return self.send_json(series_info(int(q.get('series_id', ['0'])[0])))
            if action == 'get_simple_data_table':
                sid = int(q.get('stream_id', ['0'])[0])
                with lock:
                    stats['full_epg_requests'] = stats.get('full_epg_requests', 0) + 1
                return self.send_json(simple_data_table(sid))
            if action == 'get_short_epg':
                sid = int(q.get('stream_id', ['0'])[0]); limit = int(q.get('limit', ['4'])[0])
                with lock:
                    stats['epg_requests'] += 1; stats['epg_stream_ids'].append(sid)
                if sid % 5 == 0 and sid % 50 != 0:
                    return self.send_json({'epg_listings': []})  # some channels have no EPG (archive channels always do)
                return self.send_json(short_epg(sid, limit))
            return self.send_json({})
        return super().do_GET()

if __name__ == '__main__':
    print(f'mock xtream on http://localhost:{PORT} with {N_CHANNELS} channels', flush=True)
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
