# Headless end-to-end checks

Drives the app in headless Chrome against a mock Xtream Codes server.
No TV required. Requires Node, Python 3, and Google Chrome at the default install path.

```powershell
cd test
npm install
python mock_server.py 3000      # terminal 1: mock provider (user/pass) + app at http://localhost:8765
node e2e.js                     # terminal 2: runs ~240 checks, exits non-zero on failure
node load_order.js              # no server needed: checks the load order of IPTVUltra/js/
```

`load_order.js` makes sure that code that runs at load time uses only functions
from its own file or an earlier file in the `index.html` script list. A function
from a later file is not yet defined at that time, and the app stops at
start-up.

`mock_server.py` serves `../IPTVUltra` at `/` and a fake `player_api.php` on the same origin.
`/__stats` reports how many `get_short_epg` requests the app made, which is how the lazy EPG loader is verified.
