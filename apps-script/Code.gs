/**
 * School of Accidental Photography: photo storage in Google Drive.
 *
 * Folders, inside My Drive › SBI › AccPho:
 *   AccPho – Pending   : new guest submissions land here
 *   AccPho – Approved  : everything in here appears in the gallery
 *
 * To approve a photo, move it from Pending to Approved.
 * To reject one, delete it. You can also drop your own photos
 * straight into Approved.
 */

const ACCPHO_FOLDER_ID = '17eJLmQiFyhrpqzSlE35C0wYaV1MJDl93'; // My Drive › SBI › AccPho
const PENDING_NAME  = 'AccPho – Pending';
const APPROVED_NAME = 'AccPho – Approved';
const KNOWN_IDS = {                                               // the folders as they exist today
  'AccPho – Pending':  '1UJ1hpZvGdcyd_VAlLDvlATwUWklEGvqw',
  'AccPho – Approved': '1yJhuGKQm8O82Dr4IuFxDuCC00nCvZUO8'
};
const MAX_BYTES     = 4 * 1024 * 1024;  // per photo, after the page shrinks it
const MAX_PER_HOUR  = 60;               // site-wide limit on submissions, against spam floods
const FRAMES = ['gilt','gallery','polaroid','wood','oval','chrome','accpho','thrift','film','shadowbox','neon','velvet',
  'rococo','pearl','eggdart','rope','greek','shell','laurel','dentil','reeded','scroll','lattice','beaded','rosegold','palace','acanthus','salon'];

/** Run this once from the editor: it creates the folders and asks for permission. */
function setup() {
  const p = folder_(PENDING_NAME), a = folder_(APPROVED_NAME);
  Logger.log('Pending:  ' + p.getUrl());
  Logger.log('Approved: ' + a.getUrl());
}

/** Gallery: returns the photos in the Approved folder, newest first. */
function doGet() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('gallery');
  if (hit) return json_(JSON.parse(hit));

  const files = [];
  const it = folder_(APPROVED_NAME).getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!/^image\//.test(f.getMimeType())) continue;
    if (f.getSharingAccess() !== DriveApp.Access.ANYONE_WITH_LINK) {
      try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
    }
    const m = /frame:(\w+)/.exec(f.getDescription() || '');
    files.push({
      id: f.getId(),
      src: 'https://lh3.googleusercontent.com/d/' + f.getId() + '=w1600',
      frame: m && FRAMES.indexOf(m[1]) > -1 ? m[1] : null,
      t: f.getDateCreated().getTime()
    });
  }
  files.sort((x, y) => y.t - x.t);
  cache.put('gallery', JSON.stringify(files), 120); // refreshes every 2 minutes
  return json_(files);
}

/** Submissions: saves the photo into the Pending folder. */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.website) return json_({ ok: true });            // spam trap filled in: ignore quietly

    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(body.image || '');
    if (!m) return json_({ ok: false, error: 'not an image' });
    const bytes = Utilities.base64Decode(m[2]);
    if (bytes.length > MAX_BYTES) return json_({ ok: false, error: 'too large' });

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const cache = CacheService.getScriptCache();
      const key = 'count-' + new Date().toISOString().slice(0, 13); // per hour
      const n = Number(cache.get(key) || 0);
      if (n >= MAX_PER_HOUR) return json_({ ok: false, error: 'busy' });
      cache.put(key, String(n + 1), 3700);
    } finally { lock.releaseLock(); }

    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH.mm.ss');
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const file = folder_(PENDING_NAME).createFile(Utilities.newBlob(bytes, 'image/' + m[1], 'AccPho ' + stamp + '.' + ext));
    const frame = FRAMES.indexOf(body.frame) > -1 ? body.frame : FRAMES[0];
    file.setDescription('frame:' + frame);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: 'server' });
  }
}

/** Finds (or creates) a subfolder of My Drive › SBI › AccPho. */
function folder_(name) {
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty('folder:' + name) || KNOWN_IDS[name];
  if (saved) { try { return DriveApp.getFolderById(saved); } catch (e) {} }
  const parent = DriveApp.getFolderById(ACCPHO_FOLDER_ID);
  const it = parent.getFoldersByName(name);
  const f = it.hasNext() ? it.next() : parent.createFolder(name);
  props.setProperty('folder:' + name, f.getId());
  return f;
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}


/* =========================================================
 * SEED PHOTOS FROM WIKIMEDIA COMMONS
 * Run seedFromCommons() once from the editor. It looks through
 * Wikimedia Commons categories of accidental-looking photos,
 * keeps ONLY public-domain and CC0 images (free to use, no credit
 * required), and saves them into "AccPho – Pending" with names
 * starting "Seed". Look through them and move the keepers to
 * Approved; delete the rest. Running it again skips photos it
 * already saved.
 * ========================================================= */
const SEED_CATEGORIES = [
  'Accidental finger in frame',
  'Accidental photographs',
  'Unintentional photographs',
  'Motion blur',
  'Camera shake',
  'Out of focus photographs',
  'Blurred photographs',
  'Overexposed photographs',
  'Underexposed photographs',
  'Lens flare',
  'Shadows of photographers',
  'Photographers in reflections',
  'Dutch angle photographs'
];
const SEED_PER_CATEGORY = 8;
const SEED_MAX_TOTAL    = 50;

function seedFromCommons() {
  const pending = folder_(PENDING_NAME), approved = folder_(APPROVED_NAME);
  const have = {};
  [pending, approved].forEach(f => { const it = f.getFiles(); while (it.hasNext()) have[it.next().getName()] = true; });
  const headers = { 'User-Agent': 'AccPhoSeeder/1.0 (https://accpho.allenotto.com)' };
  let saved = 0;

  for (const cat of SEED_CATEGORIES) {
    if (saved >= SEED_MAX_TOTAL) break;
    const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json'
      + '&generator=categorymembers&gcmtype=file&gcmlimit=100&gcmtitle=' + encodeURIComponent('Category:' + cat)
      + '&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=1600'
      + '&iiextmetadatafilter=License|LicenseShortName|Artist';
    let data;
    try { data = JSON.parse(UrlFetchApp.fetch(url, { headers, muteHttpExceptions: true }).getContentText()); }
    catch (e) { Logger.log(cat + ': could not read (' + e + ')'); continue; }
    const pages = data.query && data.query.pages ? Object.values(data.query.pages) : [];
    let n = 0, free = 0;
    for (const p of pages) {
      if (n >= SEED_PER_CATEGORY || saved >= SEED_MAX_TOTAL) break;
      const ii = p.imageinfo && p.imageinfo[0]; if (!ii) continue;
      if (!/^image\/(jpeg|png)$/.test(ii.mime)) continue;
      const md = ii.extmetadata || {};
      const lic = ((md.License && md.License.value) || '') + ' ' + ((md.LicenseShortName && md.LicenseShortName.value) || '');
      if (!/(^|\s)(pd|cc0|cc-zero)|public domain/i.test(lic)) continue;   // public domain / CC0 only
      free++;
      const name = 'Seed – ' + p.title.replace(/^File:/, '').replace(/\.(png|jpe?g)$/i, '') + '.jpg';
      if (have[name]) continue;
      try {
        const blob = UrlFetchApp.fetch(ii.thumburl || ii.url, { headers }).getBlob().setName(name);
        const f = pending.createFile(blob);
        f.setDescription('frame:' + FRAMES[Math.floor(Math.random() * FRAMES.length)]
          + ' | source: ' + ii.descriptionurl + ' | license: ' + lic.trim());
        have[name] = true; n++; saved++;
        Utilities.sleep(400);
      } catch (e) { Logger.log('  skipped ' + p.title + ': ' + e); }
    }
    Logger.log(cat + ': ' + pages.length + ' files, ' + free + ' public domain/CC0, saved ' + n);
  }
  Logger.log('Done. Saved ' + saved + ' photos to "' + PENDING_NAME + '".');
}
