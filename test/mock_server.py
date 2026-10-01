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
    'category_id': str((i % 30) + 1), 'tv_archive': 0,
} for i in range(1, N_CHANNELS + 1)]

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
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path == '/__stats':
            with lock:
                return self.send_json(stats)
        if u.path == '/__reset':
            with lock:
                stats['epg_requests'] = 0; stats['epg_stream_ids'] = []
            return self.send_json({'ok': True})
        if u.path == '/player_api.php':
            if q.get('username', [''])[0] != 'user' or q.get('password', [''])[0] != 'pass':
                return self.send_json({'user_info': {'auth': 0}})
            action = q.get('action', [''])[0]
            if action == '':
                return self.send_json({'user_info': {'auth': 1, 'username': 'user', 'status': 'Active'}, 'server_info': {}})
            if action == 'get_live_categories':
                return self.send_json(CATS)
            if action == 'get_live_streams':
                with lock: stats['live_streams'] += 1
                return self.send_json(STREAMS)
            if action == 'get_short_epg':
                sid = int(q.get('stream_id', ['0'])[0]); limit = int(q.get('limit', ['4'])[0])
                with lock:
                    stats['epg_requests'] += 1; stats['epg_stream_ids'].append(sid)
                if sid % 5 == 0:
                    return self.send_json({'epg_listings': []})  # some channels have no EPG
                return self.send_json(short_epg(sid, limit))
            return self.send_json({})
        return super().do_GET()

if __name__ == '__main__':
    print(f'mock xtream on http://localhost:{PORT} with {N_CHANNELS} channels', flush=True)
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
