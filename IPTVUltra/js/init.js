/**
 * @fileoverview Initialization. Keep this file last: it runs the start-up code.
 */

// ----- Initialization -----

// The app loads hls.js only when the settings select it
preloadHlsScript();

// Favorites are loaded per playlist when one is applied (favoritesLoad);
// 'iptv_favorites' is only read to convert old ones
loadSavedPlaylists();
const lastUrl = localStorage.getItem('last_m3u_url');
if (lastUrl) newM3uUrl.value = lastUrl;
// Force a channel list refresh to show favorites
if (currentGroup === 'favorites') refreshCurrentView();

// Auto-load the last playlist (setting). On failure the loader leaves the
// start page showing the error, so nothing else is needed here.
if (settings.autoLoad) {
  let lastKey = null;
  try {
    lastKey = localStorage.getItem(LAST_PLAYLIST_KEY);
  } catch (_) { /* storage unavailable */
  }
  const idx = lastKey ?
      savedPlaylists.findIndex(pl => playlistKeyOf(pl) === lastKey) :
      -1;
  if (idx >= 0) {
    const p = savedPlaylists[idx];
    selectedPlaylistId = idx;
    updateStartStatus(`Auto-loading "${p.name}" …`, false, false, true, 0);
    setTimeout(() => {
      if (p.type === 'xtream')
        loadXtreamPlaylist(p.url, p.username, p.password, p.epgUrl || '');
      else
        loadM3UFromUrl(p.url, p.epgUrl || '');
    }, 100);
  }
}
perfMark('init-done');
setTimeout(() => {
  updateFocusableElements();
  focusElement(0);
}, 500);
// Rooted TV? Then the AV sync row appears in Settings and a saved offset is
// applied
setTimeout(() => {
  hbProbe().then(ok => {
    if (ok && settings.avSync >= 0 && !document.hidden)
      avSyncApply(settings.avSync);
    if (settingsOpen) renderSettings();
  });
}, 1500);
