# End-to-end tests

The tests operate the app in Chrome without a window, with a mock Xtream Codes
server. Thus, a TV is not necessary. You must have Node.js, Python 3, and
Google Chrome in its usual directory.

Use these commands:

```powershell
cd test
npm install
python mock_server.py 3000      # terminal 1: mock provider (user/pass) + app at http://localhost:8765
node e2e.js                     # terminal 2: runs ~240 checks, exits non-zero on failure
node load_order.js              # no server needed: checks the load order of IPTVUltra/js/
```

## Load order of the app scripts

`load_order.js` examines the scripts in the `index.html` list. The code that
operates at load time must use only functions from the same file or from a
previous file in the list. A function from a subsequent file is not available
at that time, and the app stops at start-up.

## Mock server

`mock_server.py` sends the files of `../IPTVUltra` at `/`, and a mock
`player_api.php` from the same server. `/__stats` shows the number of
`get_short_epg` requests that the app sent. The tests use this number to
examine the EPG loader, which must get EPG data only for the rows on the
screen.
