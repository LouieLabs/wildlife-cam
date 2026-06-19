#include "esp_camera.h"
#include <WiFi.h>
#include "esp_http_server.h"
#include "driver/temperature_sensor.h"   // ESP32-S3 internal (chip die) temp sensor
#include "time.h"                         // NTP time
#include <HTTPClient.h>                   // geolocation + weather HTTP calls
#include <WiFiClientSecure.h>             // HTTPS for the weather API
#include "secrets.h"                      // WIFI_SSID / WIFI_PASSWORD (gitignored)

// --- Time / NTP (requires the ESP32 to have internet access) ---
// POSIX TZ string. Set to US Pacific (auto-handles PST/PDT daylight saving).
// Other examples:
//   "EST5EDT"      US Eastern      "CST6CDT"     US Central
//   "CET-1CEST"    Central Europe  "HST10"       Hawaii (no DST)
#define TIMEZONE     "PST8PDT"
#define NTP_SERVER1  "pool.ntp.org"
#define NTP_SERVER2  "time.nist.gov"

// --- Location + weather (needs internet) ---
// Location is auto-detected from the device's public IP (ip-api.com), then the
// current temperature for that spot is pulled from a weather API. If detection
// fails we fall back to these coordinates (Los Altos, CA).
#define GEO_URL            "http://ip-api.com/json/?fields=status,regionName,city,lat,lon"
#define FALLBACK_CITY      "Los Altos"
#define FALLBACK_LAT       37.3852
#define FALLBACK_LON       -122.1141
#define WEATHER_REFRESH_MS 600000UL   // re-fetch weather every 10 min

#define PWDN_GPIO_NUM     20
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM     47
#define SIOD_GPIO_NUM     45
#define SIOC_GPIO_NUM     42
#define Y9_GPIO_NUM       38
#define Y8_GPIO_NUM       48
#define Y7_GPIO_NUM       46
#define Y6_GPIO_NUM       18
#define Y5_GPIO_NUM       14
#define Y4_GPIO_NUM       12
#define Y3_GPIO_NUM       13
#define Y2_GPIO_NUM       17
#define VSYNC_GPIO_NUM    40
#define HREF_GPIO_NUM     39
#define PCLK_GPIO_NUM     21

#define PART_BOUNDARY "123456789000000000000987654321"
static const char* STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* STREAM_BOUNDARY = "\r\n--" PART_BOUNDARY "\r\n";
static const char* STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

// Two separate servers: control/UI on port 80, MJPEG stream on port 81.
// The stream handler loops forever and would otherwise hog the only worker
// task, blocking /control until you paused the stream. Splitting them means
// setting changes apply live.
httpd_handle_t camera_httpd = NULL;
httpd_handle_t stream_httpd = NULL;

temperature_sensor_handle_t temp_sensor = NULL;

// Auto-detected location + latest weather reading
float   g_lat = FALLBACK_LAT;
float   g_lon = FALLBACK_LON;
String  g_city = FALLBACK_CITY;
bool    g_located = false;
float   g_weather_c = 0;
bool    g_weather_ok = false;
unsigned long g_lastWeather = 0;

// Save destination chosen from the UI switch:
//   false = browser downloads the capture to the computer (default)
//   true  = save on the device to the SD card (SD->Firebase code reads this)
bool g_save_to_sd = false;

static const char PROGMEM INDEX_HTML[] = R"rawliteral(
<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Wildlife Cam</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;user-select:none}
  html,body{height:100%}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:radial-gradient(ellipse at top,#1a1a2e 0%,#0a0a14 50%,#000 100%);
    color:#e4e4ea;padding:14px;overflow:hidden}
  .wrap{max-width:1700px;height:calc(100vh - 28px);margin:0 auto;
    display:grid;grid-template-columns:minmax(420px,1fr) 1.3fr;gap:16px}
  @media (max-width:1000px){body{overflow:auto}.wrap{grid-template-columns:1fr;height:auto}}
  h1{font-size:24px;font-weight:700;
    background:linear-gradient(135deg,#a8edea 0%,#fed6e3 100%);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .sub{color:#8a8a9a;font-size:12px;margin-bottom:10px}
  .stats{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
  .stat{flex:1;min-width:90px;background:rgba(255,255,255,0.04);
    border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:7px 11px;
    display:flex;flex-direction:column;gap:2px}
  .stat .lbl{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#8a8a9a}
  .stat .v{font-size:15px;font-weight:600;color:#a8edea;font-variant-numeric:tabular-nums}
  .card{background:rgba(255,255,255,0.04);backdrop-filter:blur(20px);
    border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:16px;
    box-shadow:0 8px 32px rgba(0,0,0,0.3)}
  .left{display:flex;flex-direction:column;min-height:0}
  .stream-wrap{position:relative;background:#000;border-radius:12px;overflow:hidden;
    aspect-ratio:4/3;box-shadow:0 0 40px rgba(168,237,234,0.1);cursor:grab}
  .stream-wrap.dragging{cursor:grabbing}
  #stream{width:100%;height:100%;object-fit:contain;display:block;
    transform-origin:center center;transition:transform 0.15s;pointer-events:none}
  .stream-wrap.dragging #stream{transition:none}
  .stream-overlay{position:absolute;top:12px;left:12px;background:rgba(0,0,0,0.6);
    padding:6px 12px;border-radius:20px;font-size:12px;display:flex;align-items:center;gap:6px;
    pointer-events:none;z-index:2}
  .zoom-badge{position:absolute;top:12px;right:12px;background:rgba(0,0,0,0.6);
    padding:6px 12px;border-radius:20px;font-size:12px;pointer-events:none;z-index:2;
    font-variant-numeric:tabular-nums}
  .dot{width:8px;height:8px;background:#ef4444;border-radius:50%;animation:pulse 1.5s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
  .actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
  .saverow{display:flex;align-items:center;gap:10px;margin-top:12px;
    font-size:12px;color:#b4b4c4;flex-wrap:wrap}
  .seg{display:inline-flex;background:rgba(0,0,0,0.3);
    border:1px solid rgba(255,255,255,0.1);border-radius:10px;overflow:hidden}
  .seg button{flex:none;min-width:0;background:transparent;color:#b4b4c4;border:0;
    padding:8px 14px;font-size:12px;font-weight:600;border-radius:0;box-shadow:none}
  .seg button:hover{transform:none;box-shadow:none;background:rgba(255,255,255,0.05)}
  .seg button.active{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}
  button{flex:1;min-width:90px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);
    color:#fff;border:0;padding:10px 14px;border-radius:10px;font-weight:600;font-size:13px;
    cursor:pointer;transition:transform 0.15s,box-shadow 0.15s}
  button:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(102,126,234,0.4)}
  button.ghost{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1)}
  button.ghost:hover{background:rgba(255,255,255,0.1)}
  button.recording{background:linear-gradient(135deg,#ef4444,#b91c1c)}
  .presets{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:12px}
  .presets button{min-width:0;font-size:13px}
  .p-uw{background:linear-gradient(135deg,#2193b0,#6dd5ed)}
  .p-day{background:linear-gradient(135deg,#f7971e,#ffd200);color:#1a1a2e}
  .p-night{background:linear-gradient(135deg,#232526,#5b6478)}
  .status{font-size:11px;color:#888;margin-top:10px;text-align:center}
  .hint{font-size:11px;color:#666;margin-top:6px;text-align:center;font-style:italic}

  /* Settings panel: auto-flow columns so it all fits without scrolling */
  .panel{overflow:auto}
  .cols{column-width:230px;column-gap:18px}
  .group{break-inside:avoid;margin-bottom:14px}
  .group h2{font-size:12px;text-transform:uppercase;letter-spacing:1.2px;color:#8a8a9a;
    margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.06)}
  .row{margin-bottom:9px}
  .row label{display:flex;justify-content:space-between;font-size:12px;
    color:#b4b4c4;margin-bottom:4px;font-weight:500}
  .row .val{color:#a8edea;font-variant-numeric:tabular-nums}
  select,input[type=range]{width:100%;background:rgba(0,0,0,0.3);
    border:1px solid rgba(255,255,255,0.1);color:#e4e4ea;padding:6px 8px;
    border-radius:8px;font-size:12px;outline:none}
  select:focus,input[type=range]:focus{border-color:#667eea}
  input[type=range]{padding:0;height:26px;-webkit-appearance:none;background:transparent;cursor:pointer}
  input[type=range]::-webkit-slider-runnable-track{height:4px;
    background:linear-gradient(90deg,#667eea,#764ba2);border-radius:2px}
  input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;
    background:#fff;border-radius:50%;margin-top:-6px;cursor:pointer;
    box-shadow:0 2px 8px rgba(0,0,0,0.4)}
  .toggle{display:flex;align-items:center;justify-content:space-between;
    padding:7px 10px;background:rgba(0,0,0,0.2);border-radius:8px;margin-bottom:6px}
  .toggle span{font-size:12px;color:#b4b4c4}
  .switch{position:relative;width:38px;height:22px;background:rgba(255,255,255,0.1);
    border-radius:12px;cursor:pointer;transition:background 0.2s;flex:none}
  .switch.on{background:linear-gradient(135deg,#667eea,#764ba2)}
  .switch::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;
    background:#fff;border-radius:50%;transition:transform 0.2s}
  .switch.on::after{transform:translateX(16px)}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:6px}
</style></head><body>
<div class="wrap">
  <div class="left">
    <h1>Wildlife Cam</h1>
    <div class="sub">HT-HC33 ESP32-S3 HaLow camera</div>
    <div class="stats">
      <div class="stat"><span class="lbl">Date</span><span class="v" id="statDate">&mdash;</span></div>
      <div class="stat"><span class="lbl">Time</span><span class="v" id="statTime">&mdash;</span></div>
      <div class="stat"><span class="lbl">Location</span><span class="v" id="statLoc">&mdash;</span></div>
      <div class="stat"><span class="lbl">Weather</span><span class="v" id="statTemp">&mdash;</span></div>
    </div>
    <div class="card">
      <div class="stream-wrap" id="wrap">
        <img id="stream" draggable="false" crossorigin="anonymous">
        <div class="stream-overlay"><div class="dot"></div>LIVE</div>
        <div class="zoom-badge" id="zbadge">1.0x</div>
      </div>
      <div class="hint">Scroll to zoom, drag to pan</div>
      <div class="presets">
        <button class="p-uw"    onclick="applyPreset(PRESETS.underwater)">Underwater</button>
        <button class="p-day"   onclick="applyPreset(PRESETS.daylight)">Daylight</button>
        <button class="p-night" onclick="applyPreset(PRESETS.night)">Night</button>
      </div>
      <div class="saverow">
        <span>Save to:</span>
        <div class="seg" id="saveSeg">
          <button id="modeLocal" onclick="setSaveMode('local')">&#128187; My Computer</button>
          <button id="modeSD" onclick="setSaveMode('sd')">&#9729; SD + Cloud</button>
        </div>
      </div>
      <div class="actions">
        <button onclick="snap()">Snapshot</button>
        <button onclick="toggleRecord()" id="recBtn">&#9679; Record</button>
        <button class="ghost" onclick="toggleStream()" id="streamBtn">Pause</button>
        <button class="ghost" onclick="resetZoom()">Reset Zoom</button>
        <button class="ghost" onclick="fullscreen()">Fullscreen</button>
      </div>
      <div class="status" id="status">Ready</div>
    </div>
  </div>

  <div class="card panel">
    <div class="cols">
      <div class="group">
        <h2>Zoom &amp; Pan</h2>
        <div class="row">
          <label>Zoom <span class="val" id="zval">1.0x</span></label>
          <input type="range" min="100" max="500" value="100" id="zoom" oninput="setZoom(this.value)">
        </div>
      </div>

      <div class="group">
        <h2>Resolution &amp; Quality</h2>
        <div class="row">
          <label>Frame Size</label>
          <select id="framesize" onchange="set('framesize',this.value)">
            <option value="13">UXGA (1600x1200)</option>
            <option value="12">SXGA (1280x1024)</option>
            <option value="11">HD (1280x720)</option>
            <option value="10">XGA (1024x768)</option>
            <option value="9">SVGA (800x600)</option>
            <option value="8" selected>VGA (640x480)</option>
            <option value="6">HVGA (480x320)</option>
            <option value="5">CIF (400x296)</option>
            <option value="4">QVGA (320x240)</option>
            <option value="3">240x240</option>
            <option value="1">QQVGA (160x120)</option>
            <option value="0">96x96</option>
          </select>
        </div>
        <div class="row">
          <label>JPEG Quality <span class="val" id="qval">12</span></label>
          <input type="range" min="4" max="63" value="12" id="quality"
            oninput="qval.textContent=this.value" onchange="set('quality',this.value)">
        </div>
      </div>

      <div class="group">
        <h2>Image</h2>
        <div class="row">
          <label>Brightness <span class="val" id="bval">0</span></label>
          <input type="range" min="-2" max="2" value="0" id="brightness"
            oninput="bval.textContent=this.value" onchange="set('brightness',this.value)">
        </div>
        <div class="row">
          <label>Contrast <span class="val" id="cval">0</span></label>
          <input type="range" min="-2" max="2" value="0" id="contrast"
            oninput="cval.textContent=this.value" onchange="set('contrast',this.value)">
        </div>
        <div class="row">
          <label>Saturation <span class="val" id="sval">0</span></label>
          <input type="range" min="-2" max="2" value="0" id="saturation"
            oninput="sval.textContent=this.value" onchange="set('saturation',this.value)">
        </div>
        <div class="row">
          <label>Special Effect</label>
          <select id="special_effect" onchange="set('special_effect',this.value)">
            <option value="0" selected>None</option>
            <option value="1">Negative</option>
            <option value="2">Grayscale</option>
            <option value="3">Red Tint</option>
            <option value="4">Green Tint</option>
            <option value="5">Blue Tint</option>
            <option value="6">Sepia</option>
          </select>
        </div>
      </div>

      <div class="group">
        <h2>White Balance</h2>
        <div class="toggle"><span>Auto White Balance</span>
          <div class="switch on" data-k="whitebal" onclick="tog(this,'whitebal')"></div></div>
        <div class="toggle"><span>AWB Gain</span>
          <div class="switch on" data-k="awb_gain" onclick="tog(this,'awb_gain')"></div></div>
        <div class="row">
          <label>WB Mode</label>
          <select id="wb_mode" onchange="set('wb_mode',this.value)">
            <option value="0" selected>Auto</option>
            <option value="1">Sunny</option>
            <option value="2">Cloudy</option>
            <option value="3">Office</option>
            <option value="4">Home</option>
          </select>
        </div>
      </div>

      <div class="group">
        <h2>Exposure &amp; Gain</h2>
        <div class="toggle"><span>Auto Exposure</span>
          <div class="switch on" data-k="exposure_ctrl" onclick="tog(this,'exposure_ctrl')"></div></div>
        <div class="toggle"><span>AEC DSP</span>
          <div class="switch on" data-k="aec2" onclick="tog(this,'aec2')"></div></div>
        <div class="row">
          <label>AE Level <span class="val" id="aval">0</span></label>
          <input type="range" min="-2" max="2" value="0" id="ae_level"
            oninput="aval.textContent=this.value" onchange="set('ae_level',this.value)">
        </div>
        <div class="row">
          <label>Exposure <span class="val" id="eval">300</span></label>
          <input type="range" min="0" max="1200" value="300" id="aec_value"
            oninput="eval.textContent=this.value" onchange="set('aec_value',this.value)">
        </div>
        <div class="toggle"><span>Auto Gain</span>
          <div class="switch on" data-k="gain_ctrl" onclick="tog(this,'gain_ctrl')"></div></div>
        <div class="row">
          <label>Gain <span class="val" id="gval">0</span></label>
          <input type="range" min="0" max="30" value="0" id="agc_gain"
            oninput="gval.textContent=this.value" onchange="set('agc_gain',this.value)">
        </div>
        <div class="row">
          <label>Gain Ceiling</label>
          <select id="gainceiling" onchange="set('gainceiling',this.value)">
            <option value="0" selected>2x</option><option value="1">4x</option>
            <option value="2">8x</option><option value="3">16x</option>
            <option value="4">32x</option><option value="5">64x</option>
            <option value="6">128x</option>
          </select>
        </div>
      </div>

      <div class="group">
        <h2>Pixel Processing</h2>
        <div class="grid2">
          <div class="toggle"><span>BPC</span>
            <div class="switch" data-k="bpc" onclick="tog(this,'bpc')"></div></div>
          <div class="toggle"><span>WPC</span>
            <div class="switch on" data-k="wpc" onclick="tog(this,'wpc')"></div></div>
          <div class="toggle"><span>Gamma</span>
            <div class="switch on" data-k="raw_gma" onclick="tog(this,'raw_gma')"></div></div>
          <div class="toggle"><span>Lens Corr</span>
            <div class="switch on" data-k="lenc" onclick="tog(this,'lenc')"></div></div>
          <div class="toggle"><span>H Mirror</span>
            <div class="switch" data-k="hmirror" onclick="tog(this,'hmirror')"></div></div>
          <div class="toggle"><span>V Flip</span>
            <div class="switch" data-k="vflip" onclick="tog(this,'vflip')"></div></div>
          <div class="toggle"><span>DCW</span>
            <div class="switch on" data-k="dcw" onclick="tog(this,'dcw')"></div></div>
          <div class="toggle"><span>Color Bar</span>
            <div class="switch" data-k="colorbar" onclick="tog(this,'colorbar')"></div></div>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
  const status = document.getElementById('status');
  const stream = document.getElementById('stream');
  const wrap   = document.getElementById('wrap');
  const zbadge = document.getElementById('zbadge');
  let streaming = true;

  // The MJPEG stream lives on its own server on port 81 (this page is on 80).
  // Set this FIRST, before any other init, so nothing can stop the feed loading.
  const STREAM_URL = location.protocol + '//' + location.hostname + ':81/stream';
  stream.src = STREAM_URL;

  // ====== CHANGE YOUR CAMERA NAME HERE ======
  const CAMERA_NAME = "Camera 1";

  // ====== SAVE DESTINATION (the switch) ======
  // 'local' = download to this computer (your Louie Labs folders).
  // 'sd'    = save on the camera's SD card (the SD->Firebase uploader handles it).
  let saveMode = 'local';
  try { saveMode = localStorage.getItem('cw_saveMode') || 'local'; } catch(e){}
  function setSaveMode(m){
    saveMode = (m === 'sd') ? 'sd' : 'local';
    try { localStorage.setItem('cw_saveMode', saveMode); } catch(e){}
    const bl = document.getElementById('modeLocal'), bs = document.getElementById('modeSD');
    if(bl) bl.classList.toggle('active', saveMode === 'local');
    if(bs) bs.classList.toggle('active', saveMode === 'sd');
    fetch('/savemode?sd=' + (saveMode === 'sd' ? 1 : 0)).catch(()=>{});  // tell the camera
    status.textContent = (saveMode === 'sd')
      ? 'Saving to SD card + cloud (on the camera)'
      : 'Saving to this computer';
  }
  try { setSaveMode(saveMode); } catch(e){}   // apply remembered choice; never block the page

  // ============ DATE / TIME / TEMP ============
  // Time comes from the CAMERA's NTP-synced clock (via /status), not the
  // viewer's device. We sync a base epoch on each poll and tick locally in
  // between so the seconds advance smoothly without polling every second.
  const pad = n => String(n).padStart(2,'0');
  let srvEpoch=0, srvTzOff=0, srvAt=0, srvSynced=false;

  function tick(){
    if(!srvSynced){
      document.getElementById('statDate').textContent='—';
      document.getElementById('statTime').textContent='syncing…';
      return;
    }
    const sec = srvEpoch + Math.floor((Date.now()-srvAt)/1000);
    // Add the device's UTC offset, then read with getUTC* so the browser's own
    // timezone never enters into it — this shows the camera's local wall clock.
    const d = new Date((sec + srvTzOff)*1000);
    document.getElementById('statDate').textContent =
      d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate());
    document.getElementById('statTime').textContent =
      pad(d.getUTCHours())+':'+pad(d.getUTCMinutes())+':'+pad(d.getUTCSeconds());
  }
  tick(); setInterval(tick, 1000);

  function pollStatus(){
    fetch('/status')
      .then(r=>r.json())
      .then(j=>{
        if(j.synced){ srvEpoch=j.epoch; srvTzOff=j.tz_offset; srvAt=Date.now(); srvSynced=true; }
        document.getElementById('statLoc').textContent =
          (j.city && j.city.length) ? j.city : (j.located ? '—' : 'locating…');
        document.getElementById('statTemp').textContent =
          j.weather_ok ? Math.round(j.weather_f)+'°F' : '…';
      })
      .catch(()=>{
        document.getElementById('statLoc').textContent = 'n/a';
        document.getElementById('statTemp').textContent = 'n/a';
      });
  }
  pollStatus(); setInterval(pollStatus, 5000);

  function set(k,v){
    fetch('/control?var='+k+'&val='+v)
      .then(()=>status.textContent=k+' = '+v)
      .catch(e=>status.textContent='Error: '+e);
  }
  function tog(el,k){
    el.classList.toggle('on');
    set(k, el.classList.contains('on')?1:0);
  }

  // ============ PRESETS ============
  // Each preset is a map of control var -> value. applyPreset() pushes every
  // value to the camera AND syncs the matching slider / select / toggle in the UI.
  const PRESETS = {
    // Water swallows red/warm light -> push warm WB + saturation to bring color back.
    underwater: {whitebal:1, awb_gain:1, wb_mode:2, special_effect:0,
                 saturation:2, contrast:1, brightness:1, ae_level:1,
                 exposure_ctrl:1, aec2:1, gain_ctrl:1, gainceiling:3, raw_gma:1, lenc:1},
    // Balanced outdoor / land defaults, sunny WB, low gain for clean daylight.
    daylight:   {whitebal:1, awb_gain:1, wb_mode:1, special_effect:0,
                 saturation:0, contrast:0, brightness:0, ae_level:0,
                 exposure_ctrl:1, aec2:1, gain_ctrl:1, agc_gain:0, gainceiling:0, raw_gma:1, lenc:1},
    // Low light: max auto exposure + gain headroom, lift brightness, gamma on.
    night:      {whitebal:1, awb_gain:1, wb_mode:0, special_effect:0,
                 saturation:0, contrast:1, brightness:1, ae_level:2,
                 exposure_ctrl:1, aec2:1, gain_ctrl:1, gainceiling:6, raw_gma:1, lenc:1}
  };
  // var -> id of its value-display span (for sliders that show a number)
  const DISP = {brightness:'bval', contrast:'cval', saturation:'sval', quality:'qval',
                ae_level:'aval', aec_value:'eval', agc_gain:'gval'};

  function uiSet(k,v){
    set(k,v);
    const el = document.getElementById(k);          // slider or select
    if(el && el.tagName !== 'DIV') el.value = v;
    if(DISP[k]) document.getElementById(DISP[k]).textContent = v;
    const sw = document.querySelector('[data-k="'+k+'"]');   // toggle switch
    if(sw) sw.classList.toggle('on', v == 1);
  }
  function applyPreset(p){
    for(const k in p) uiSet(k, p[k]);
    status.textContent = 'Preset applied';
  }

  // ============ SNAPSHOT (burned-in caption strip + EXIF) ============
  // Done in the browser: grab a frame + live /status, draw a caption strip on a
  // canvas, embed the camera settings + GPS into EXIF, then download.
  const SNAP_SLIDERS=['framesize','quality','brightness','contrast','saturation',
    'special_effect','wb_mode','ae_level','aec_value','agc_gain','gainceiling','zoom'];
  const SNAP_TOGGLES=['whitebal','awb_gain','exposure_ctrl','aec2','gain_ctrl',
    'bpc','wpc','raw_gma','lenc','hmirror','vflip','dcw','colorbar'];

  function gatherSettings(){
    const p=[];
    SNAP_SLIDERS.forEach(id=>{const el=document.getElementById(id); if(el) p.push(id+'='+el.value);});
    SNAP_TOGGLES.forEach(k=>{const sw=document.querySelector('[data-k="'+k+'"]');
      if(sw) p.push(k+'='+(sw.classList.contains('on')?1:0));});
    return p.join(' ');
  }

  function snapStrings(st){
    let d;
    if(st && st.synced) d=new Date((st.epoch+st.tz_offset)*1000);
    else { const n=new Date();   // browser fallback, formatted as UTC to avoid TZ shift
      d=new Date(Date.UTC(n.getFullYear(),n.getMonth(),n.getDate(),n.getHours(),n.getMinutes(),n.getSeconds())); }
    const date=d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate());
    const time=pad(d.getUTCHours())+':'+pad(d.getUTCMinutes())+':'+pad(d.getUTCSeconds());
    return {date, time, exifDt:date.replace(/-/g,':')+' '+time};
  }

  // SD + Cloud mode: tell the camera to save the snapshot onto its SD card.
  async function snapToSD(){
    status.textContent='Saving to SD…';
    try{
      const r=await fetch('/capture_sd?t='+Date.now());
      const txt=(await r.text()).trim();
      status.textContent = txt.indexOf('SAVED')>=0
        ? 'Photo saved to SD card (uploading to cloud)'
        : "SD saving isn't wired up on the camera yet";
    }catch(e){ status.textContent='SD save failed: '+e; }
  }

  async function snap(){
    if(saveMode === 'sd'){ return snapToSD(); }
    status.textContent='Capturing…';
    let st={};
    try{ st=await fetch('/status').then(r=>r.json()); }catch(e){}
    let blob;
    try{ blob=await fetch('/capture?t='+Date.now()).then(r=>r.blob()); }
    catch(e){ status.textContent='Capture failed'; return; }
    const img=await createImageBitmap(blob);

    const ts=snapStrings(st);
    const loc=(st.city&&st.city.length)?st.city:'Unknown';
    const tF=st.weather_ok?Math.round(st.weather_f)+'°F':'n/a';

    const stripH=Math.max(30, Math.round(img.height*0.06));
    const cv=document.createElement('canvas');
    cv.width=img.width; cv.height=img.height+stripH;
    const ctx=cv.getContext('2d');
    ctx.drawImage(img,0,0);
    ctx.fillStyle='rgba(0,0,0,0.85)';
    ctx.fillRect(0,img.height,cv.width,stripH);

    const caption=CAMERA_NAME+'   |   '+ts.date+'  '+ts.time+'   |   '+loc+'   |   '+tF;
    let fs=Math.round(stripH*0.5);
    ctx.fillStyle='#fff'; ctx.textBaseline='middle';
    ctx.font=fs+'px -apple-system,Segoe UI,Roboto,sans-serif';
    while(ctx.measureText(caption).width>cv.width-20 && fs>8){
      fs--; ctx.font=fs+'px -apple-system,Segoe UI,Roboto,sans-serif';
    }
    ctx.fillText(caption, 12, img.height+stripH/2);

    cv.toBlob(async b=>{
      let bytes=new Uint8Array(await b.arrayBuffer());
      try{
        bytes=addExif(bytes,{
          make:CAMERA_NAME, model:'HT-HC33 ESP32-S3', software:'wildlife_cam.ino',
          dt:ts.exifDt,
          desc:CAMERA_NAME+' | '+loc+' | '+
               (st.weather_ok?Math.round(st.weather_c)+'C/'+Math.round(st.weather_f)+'F':'temp n/a')+
               ' | '+gatherSettings(),
          lat:st.lat, lon:st.lon
        });
      }catch(e){ /* fall back to plain JPEG if EXIF build fails */ }
      const fn='wildcam_'+ts.date.replace(/-/g,'')+'_'+ts.time.replace(/:/g,'')+'.jpg';
      const url=URL.createObjectURL(new Blob([bytes],{type:'image/jpeg'}));
      const a=document.createElement('a'); a.href=url; a.download=fn; a.click();
      setTimeout(()=>URL.revokeObjectURL(url),3000);
      status.textContent='Snapshot saved: '+fn;
    },'image/jpeg',0.92);
  }

  // Build & splice an EXIF (APP1) segment into a JPEG. Little-endian TIFF with
  // IFD0 (description/make/model/software/datetime), an Exif sub-IFD
  // (DateTimeOriginal + UserComment), and a GPS sub-IFD when coords are known.
  function addExif(jpeg, f){
    const T={BYTE:1,ASCII:2,LONG:4,RATIONAL:5,UNDEF:7};
    const clean=s=>String(s==null?'':s).replace(/[^\x20-\x7e]/g,'?');
    const u32=v=>[v&255,(v>>8)&255,(v>>16)&255,(v>>>24)&255];
    const ascii=s=>{s=clean(s);const a=[];for(let i=0;i<s.length;i++)a.push(s.charCodeAt(i));a.push(0);return{type:T.ASCII,count:a.length,bytes:a};};
    const long=v=>({type:T.LONG,count:1,bytes:u32(v)});
    const bytesT=arr=>({type:T.BYTE,count:arr.length,bytes:arr.slice()});
    const ucomment=s=>{s=clean(s);const a=[0x41,0x53,0x43,0x49,0x49,0,0,0];for(let i=0;i<s.length;i++)a.push(s.charCodeAt(i));return{type:T.UNDEF,count:a.length,bytes:a};};
    const rats=pairs=>{const a=[];pairs.forEach(p=>{a.push.apply(a,u32(p[0]));a.push.apply(a,u32(p[1]));});return{type:T.RATIONAL,count:pairs.length,bytes:a};};
    const gpsR=dec=>{dec=Math.abs(dec);const d=Math.floor(dec);const mf=(dec-d)*60;const m=Math.floor(mf);const s=Math.round((mf-m)*60*1000);return rats([[d,1],[m,1],[s,1000]]);};

    const ifd0=[
      {tag:0x010E,data:ascii(f.desc)},
      {tag:0x010F,data:ascii(f.make)},
      {tag:0x0110,data:ascii(f.model)},
      {tag:0x0131,data:ascii(f.software)},
      {tag:0x0132,data:ascii(f.dt)},
    ];
    const exif=[
      {tag:0x9003,data:ascii(f.dt)},
      {tag:0x9286,data:ucomment(f.desc)},
    ];
    const haveGps=isFinite(f.lat)&&isFinite(f.lon)&&(f.lat!==0||f.lon!==0);
    let gps=null;
    if(haveGps){
      gps=[
        {tag:0x0000,data:bytesT([2,3,0,0])},
        {tag:0x0001,data:ascii(f.lat>=0?'N':'S')},
        {tag:0x0002,data:gpsR(f.lat)},
        {tag:0x0003,data:ascii(f.lon>=0?'E':'W')},
        {tag:0x0004,data:gpsR(f.lon)},
      ];
    }

    const exifPtr={tag:0x8769,data:long(0)}; ifd0.push(exifPtr);
    let gpsPtr=null;
    if(gps){ gpsPtr={tag:0x8825,data:long(0)}; ifd0.push(gpsPtr); }

    const bytag=(a,b)=>a.tag-b.tag;
    ifd0.sort(bytag); exif.sort(bytag); if(gps)gps.sort(bytag);

    const sizes=es=>{let data=0;es.forEach(e=>{const L=e.data.bytes.length; if(L>4) data+=L+(L&1);});return{hdr:2+12*es.length+4, data};};
    const s0=sizes(ifd0), sE=sizes(exif), sG=gps?sizes(gps):{hdr:0,data:0};
    const off0=8, data0=off0+s0.hdr;
    const offE=data0+s0.data, dataE=offE+sE.hdr;
    const offG=gps?dataE+sE.data:0, dataG=gps?offG+sG.hdr:0;
    const total=gps?dataG+sG.data:dataE+sE.data;

    exifPtr.data=long(offE);
    if(gps)gpsPtr.data=long(offG);

    const tiff=new Array(total).fill(0);
    const setU16=(p,v)=>{tiff[p]=v&255;tiff[p+1]=(v>>8)&255;};
    const setU32=(p,v)=>{tiff[p]=v&255;tiff[p+1]=(v>>8)&255;tiff[p+2]=(v>>16)&255;tiff[p+3]=(v>>>24)&255;};
    tiff[0]=0x49;tiff[1]=0x49;tiff[2]=0x2A;tiff[3]=0x00;setU32(4,8);

    function writeIFD(es,ifdOff,dataOff,next){
      let p=ifdOff, d=dataOff;
      setU16(p,es.length); p+=2;
      es.forEach(e=>{
        setU16(p,e.tag); setU16(p+2,e.data.type); setU32(p+4,e.data.count);
        const b=e.data.bytes;
        if(b.length<=4){ for(let i=0;i<4;i++) tiff[p+8+i]=i<b.length?b[i]:0; }
        else { setU32(p+8,d); for(let i=0;i<b.length;i++) tiff[d+i]=b[i]; let L=b.length; if(L&1){tiff[d+L]=0;L++;} d+=L; }
        p+=12;
      });
      setU32(p,next);
    }
    writeIFD(ifd0,off0,data0,0);
    writeIFD(exif,offE,dataE,0);
    if(gps) writeIFD(gps,offG,dataG,0);

    const payload=[0x45,0x78,0x69,0x66,0,0].concat(tiff);   // "Exif\0\0" + TIFF
    const segLen=payload.length+2;                          // length field counts itself
    const app1=Uint8Array.from([0xFF,0xE1,(segLen>>8)&255,segLen&255].concat(payload));

    const out=new Uint8Array(2+app1.length+(jpeg.length-2));  // splice right after SOI
    out.set(jpeg.subarray(0,2),0);
    out.set(app1,2);
    out.set(jpeg.subarray(2),2+app1.length);
    return out;
  }
  function toggleStream(){
    const btn=document.getElementById('streamBtn');
    if(streaming){stream.src='';btn.textContent='Resume';streaming=false}
    else{stream.src=STREAM_URL;btn.textContent='Pause';streaming=true}
  }
  function fullscreen(){
    if(wrap.requestFullscreen)wrap.requestFullscreen();
  }

  // ============ RECORD (in-browser, overlay burned in -> .webm) ============
  // Draws the live frame + a caption strip onto a hidden canvas every frame and
  // records that canvas with MediaRecorder. Needs the stream marked crossorigin
  // (the server already sends Access-Control-Allow-Origin), else the canvas is
  // tainted and recording is blocked.
  const recCanvas = document.createElement('canvas');
  const recCtx = recCanvas.getContext('2d');
  let recording = false, mediaRec = null, recChunks = [], recRAF = 0;

  function recCaption(){
    const g = id => document.getElementById(id).textContent;
    return CAMERA_NAME+'   '+g('statDate')+' '+g('statTime')+'   '+g('statLoc')+'   '+g('statTemp');
  }
  function recDraw(){
    if(!recording) return;
    const w = stream.naturalWidth || 640, h = stream.naturalHeight || 480;
    const strip = Math.max(24, Math.round(h*0.06));
    if(recCanvas.width !== w || recCanvas.height !== h+strip){ recCanvas.width=w; recCanvas.height=h+strip; }
    try { recCtx.drawImage(stream, 0, 0, w, h); } catch(e){}
    recCtx.fillStyle='rgba(0,0,0,0.85)'; recCtx.fillRect(0,h,w,strip);
    let fs=Math.max(10,Math.round(strip*0.5));
    recCtx.fillStyle='#fff'; recCtx.textBaseline='middle';
    recCtx.font=fs+'px -apple-system,Segoe UI,Roboto,sans-serif';
    const cap=recCaption();
    while(recCtx.measureText(cap).width>w-16 && fs>8){ fs--; recCtx.font=fs+'px -apple-system,Segoe UI,Roboto,sans-serif'; }
    recCtx.fillText(cap, 10, h+strip/2);
    recRAF=requestAnimationFrame(recDraw);
  }
  function toggleRecord(){
    const btn=document.getElementById('recBtn');
    if(saveMode === 'sd' && !recording){
      status.textContent='In SD + Cloud mode, recording is handled on the camera (SD → cloud).';
      return;
    }
    if(!recording){
      if(!streaming) toggleStream();                 // make sure the feed is live
      recording=true; recDraw();
      let mime='video/webm;codecs=vp9';
      if(!MediaRecorder.isTypeSupported(mime)) mime='video/webm;codecs=vp8';
      if(!MediaRecorder.isTypeSupported(mime)) mime='video/webm';
      let cs;
      try { cs=recCanvas.captureStream(12); }          // 12 fps
      catch(e){ recording=false; status.textContent='Recording blocked (stream not allowed on canvas)'; return; }
      recChunks=[];
      try { mediaRec=new MediaRecorder(cs,{mimeType:mime}); }
      catch(e){ recording=false; status.textContent='Recorder error: '+e.message; return; }
      mediaRec.ondataavailable=e=>{ if(e.data&&e.data.size) recChunks.push(e.data); };
      mediaRec.onstop=()=>{
        if(!recChunks.length){ status.textContent='Recording failed (no data captured)'; return; }
        const blob=new Blob(recChunks,{type:'video/webm'});
        const url=URL.createObjectURL(blob);
        const g=id=>document.getElementById(id).textContent;
        const fn='wildcam_'+CAMERA_NAME.replace(/\s+/g,'_')+'_'+g('statDate').replace(/-/g,'')+'_'+g('statTime').replace(/:/g,'')+'.webm';
        const a=document.createElement('a'); a.href=url; a.download=fn; a.click();
        setTimeout(()=>URL.revokeObjectURL(url),4000);
        status.textContent='Recording saved: '+fn;
      };
      try { mediaRec.start(); }
      catch(e){ recording=false; status.textContent='Could not start: '+e.message; return; }
      btn.innerHTML='&#9632; Stop'; btn.classList.add('recording'); status.textContent='Recording…';
    } else {
      recording=false;
      if(recRAF) cancelAnimationFrame(recRAF);
      if(mediaRec && mediaRec.state!=='inactive') mediaRec.stop();
      btn.innerHTML='&#9679; Record'; btn.classList.remove('recording');
    }
  }

  // ============ ZOOM & PAN ============
  let zoom=1, panX=0, panY=0;
  let dragging=false, startMX=0, startMY=0, startPX=0, startPY=0;

  function applyT(){
    stream.style.transform='translate('+panX+'px,'+panY+'px) scale('+zoom+')';
    zbadge.textContent=zoom.toFixed(1)+'x';
  }
  function setZoom(v){
    zoom=v/100;
    document.getElementById('zval').textContent=zoom.toFixed(1)+'x';
    if(zoom<=1){panX=0;panY=0}
    applyT();
  }
  function resetZoom(){
    zoom=1;panX=0;panY=0;
    document.getElementById('zoom').value=100;
    document.getElementById('zval').textContent='1.0x';
    applyT();
  }

  wrap.addEventListener('mousedown',e=>{
    if(zoom<=1)return;
    dragging=true;
    wrap.classList.add('dragging');
    startMX=e.clientX; startMY=e.clientY;
    startPX=panX; startPY=panY;
    e.preventDefault();
  });
  window.addEventListener('mousemove',e=>{
    if(!dragging)return;
    panX = startPX + (e.clientX-startMX);
    panY = startPY + (e.clientY-startMY);
    applyT();
  });
  window.addEventListener('mouseup',()=>{
    dragging=false;
    wrap.classList.remove('dragging');
  });

  wrap.addEventListener('wheel',e=>{
    e.preventDefault();
    const sl=document.getElementById('zoom');
    let v=parseInt(sl.value)+(e.deltaY<0?25:-25);
    v=Math.max(100,Math.min(500,v));
    sl.value=v;
    setZoom(v);
  },{passive:false});

  // touch pan/zoom for phones
  let touchStartDist=0, touchStartZoom=100;
  wrap.addEventListener('touchstart',e=>{
    if(e.touches.length===1 && zoom>1){
      dragging=true;
      startMX=e.touches[0].clientX; startMY=e.touches[0].clientY;
      startPX=panX; startPY=panY;
    } else if(e.touches.length===2){
      const dx=e.touches[0].clientX-e.touches[1].clientX;
      const dy=e.touches[0].clientY-e.touches[1].clientY;
      touchStartDist=Math.hypot(dx,dy);
      touchStartZoom=parseInt(document.getElementById('zoom').value);
    }
  });
  wrap.addEventListener('touchmove',e=>{
    if(e.touches.length===1 && dragging){
      panX = startPX + (e.touches[0].clientX-startMX);
      panY = startPY + (e.touches[0].clientY-startMY);
      applyT();
      e.preventDefault();
    } else if(e.touches.length===2){
      const dx=e.touches[0].clientX-e.touches[1].clientX;
      const dy=e.touches[0].clientY-e.touches[1].clientY;
      const dist=Math.hypot(dx,dy);
      let v=Math.round(touchStartZoom * (dist/touchStartDist));
      v=Math.max(100,Math.min(500,v));
      document.getElementById('zoom').value=v;
      setZoom(v);
      e.preventDefault();
    }
  },{passive:false});
  wrap.addEventListener('touchend',()=>{dragging=false});
</script>
</body></html>
)rawliteral";

static esp_err_t index_handler(httpd_req_t *req) {
  httpd_resp_set_type(req, "text/html");
  // Never let the browser cache the page, so a re-flash always serves fresh HTML
  // (stale cached pages are the classic "I re-flashed but it's still broken").
  httpd_resp_set_hdr(req, "Cache-Control", "no-cache, no-store, must-revalidate");
  return httpd_resp_send(req, (const char*)INDEX_HTML, strlen(INDEX_HTML));
}

static esp_err_t stream_handler(httpd_req_t *req) {
  camera_fb_t *fb = NULL;
  esp_err_t res = ESP_OK;
  char part_buf[64];

  res = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
  if (res != ESP_OK) return res;
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

  while (true) {
    fb = esp_camera_fb_get();
    if (!fb) { res = ESP_FAIL; break; }

    if (httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY)) == ESP_OK) {
      size_t hlen = snprintf(part_buf, sizeof(part_buf), STREAM_PART, fb->len);
      res = httpd_resp_send_chunk(req, part_buf, hlen);
    }
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, (const char*)fb->buf, fb->len);
    esp_camera_fb_return(fb);
    if (res != ESP_OK) break;
  }
  return res;
}

static esp_err_t capture_handler(httpd_req_t *req) {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) { httpd_resp_send_500(req); return ESP_FAIL; }
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=capture.jpg");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  esp_err_t res = httpd_resp_send(req, (const char*)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  return res;
}

static esp_err_t control_handler(httpd_req_t *req) {
  char query[100], var[32], val[32];
  if (httpd_req_get_url_query_str(req, query, sizeof(query)) != ESP_OK) {
    httpd_resp_send_404(req); return ESP_FAIL;
  }
  httpd_query_key_value(query, "var", var, sizeof(var));
  httpd_query_key_value(query, "val", val, sizeof(val));
  int v = atoi(val);

  sensor_t *s = esp_camera_sensor_get();
  int r = -1;
  if      (!strcmp(var,"framesize"))       r = s->set_framesize(s, (framesize_t)v);
  else if (!strcmp(var,"quality"))         r = s->set_quality(s, v);
  else if (!strcmp(var,"brightness"))      r = s->set_brightness(s, v);
  else if (!strcmp(var,"contrast"))        r = s->set_contrast(s, v);
  else if (!strcmp(var,"saturation"))      r = s->set_saturation(s, v);
  else if (!strcmp(var,"special_effect"))  r = s->set_special_effect(s, v);
  else if (!strcmp(var,"whitebal"))        r = s->set_whitebal(s, v);
  else if (!strcmp(var,"awb_gain"))        r = s->set_awb_gain(s, v);
  else if (!strcmp(var,"wb_mode"))         r = s->set_wb_mode(s, v);
  else if (!strcmp(var,"exposure_ctrl"))   r = s->set_exposure_ctrl(s, v);
  else if (!strcmp(var,"aec2"))            r = s->set_aec2(s, v);
  else if (!strcmp(var,"ae_level"))        r = s->set_ae_level(s, v);
  else if (!strcmp(var,"aec_value"))       r = s->set_aec_value(s, v);
  else if (!strcmp(var,"gain_ctrl"))       r = s->set_gain_ctrl(s, v);
  else if (!strcmp(var,"agc_gain"))        r = s->set_agc_gain(s, v);
  else if (!strcmp(var,"gainceiling"))     r = s->set_gainceiling(s, (gainceiling_t)v);
  else if (!strcmp(var,"bpc"))             r = s->set_bpc(s, v);
  else if (!strcmp(var,"wpc"))             r = s->set_wpc(s, v);
  else if (!strcmp(var,"raw_gma"))         r = s->set_raw_gma(s, v);
  else if (!strcmp(var,"lenc"))            r = s->set_lenc(s, v);
  else if (!strcmp(var,"hmirror"))         r = s->set_hmirror(s, v);
  else if (!strcmp(var,"vflip"))           r = s->set_vflip(s, v);
  else if (!strcmp(var,"dcw"))             r = s->set_dcw(s, v);
  else if (!strcmp(var,"colorbar"))        r = s->set_colorbar(s, v);

  Serial.printf("control: %s=%d ret=%d\n", var, v, r);
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, "OK", 2);
}

// ---------- Location + weather ----------
static bool httpGET(const String& url, String& out) {
  HTTPClient http;
  http.setConnectTimeout(5000);
  http.setTimeout(5000);
  bool ok = false;
  if (url.startsWith("https")) {
    WiFiClientSecure client;
    client.setInsecure();               // no CA store on the device; skip cert check
    if (http.begin(client, url)) {
      if (http.GET() == 200) { out = http.getString(); ok = true; }
      http.end();
    }
  } else {
    WiFiClient client;
    if (http.begin(client, url)) {
      if (http.GET() == 200) { out = http.getString(); ok = true; }
      http.end();
    }
  }
  return ok;
}

// Minimal JSON helpers so we don't pull in a JSON library.
static float jsonNumFrom(const String& s, const char* key, int from, float dflt) {
  if (from < 0) from = 0;
  String k = String("\"") + key + "\"";
  int i = s.indexOf(k, from);
  if (i < 0) return dflt;
  i = s.indexOf(':', i + k.length());
  if (i < 0) return dflt;
  return s.substring(i + 1).toFloat();
}
static String jsonStr(const String& s, const char* key) {
  String k = String("\"") + key + "\"";
  int i = s.indexOf(k);
  if (i < 0) return "";
  i = s.indexOf(':', i + k.length());
  if (i < 0) return "";
  i = s.indexOf('"', i);
  if (i < 0) return "";
  int j = s.indexOf('"', i + 1);
  if (j < 0) return "";
  return s.substring(i + 1, j);
}

// Approximate location from the public IP (ISP geolocation).
static void locateDevice() {
  String body;
  if (httpGET(GEO_URL, body) && jsonStr(body, "status") == "success") {
    g_lat = jsonNumFrom(body, "lat", 0, g_lat);
    g_lon = jsonNumFrom(body, "lon", 0, g_lon);
    String city = jsonStr(body, "city");
    if (city.length()) g_city = city;
    g_located = true;
    Serial.printf("Location: %s  (%.4f, %.4f)\n", g_city.c_str(), g_lat, g_lon);
  } else {
    Serial.printf("Geolocation failed; using fallback: %s\n", g_city.c_str());
  }
}

// Current temperature for our coordinates.
static void fetchWeather() {
  char url[180];
  String body;

  // Primary: Open-Meteo (HTTPS, no API key, structured JSON).
  snprintf(url, sizeof(url),
    "https://api.open-meteo.com/v1/forecast?latitude=%.4f&longitude=%.4f&current=temperature_2m",
    g_lat, g_lon);
  if (httpGET(String(url), body)) {
    int ci = body.indexOf("\"current\":");      // skip the "current_units" block
    float t = jsonNumFrom(body, "temperature_2m", ci, NAN);
    if (!isnan(t)) {
      g_weather_c = t; g_weather_ok = true;
      Serial.printf("Weather (open-meteo): %.1f C\n", t);
      return;
    }
  }

  // Fallback: wttr.in over plain HTTP (works if HTTPS is unavailable).
  String url2 = "http://wttr.in/" + String(g_lat, 4) + "," + String(g_lon, 4) + "?format=j1";
  if (httpGET(url2, body)) {
    String tc = jsonStr(body, "temp_C");
    if (tc.length()) {
      g_weather_c = tc.toFloat(); g_weather_ok = true;
      Serial.printf("Weather (wttr.in): %.1f C\n", g_weather_c);
      return;
    }
  }

  g_weather_ok = false;
  Serial.println("Weather fetch failed");
}

// Set the save destination from the UI switch (?sd=1 -> SD card, ?sd=0 -> computer).
static esp_err_t savemode_handler(httpd_req_t *req) {
  char query[32], val[8];
  if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK &&
      httpd_query_key_value(query, "sd", val, sizeof(val)) == ESP_OK) {
    g_save_to_sd = (atoi(val) != 0);
  }
  Serial.printf("save mode: %s\n", g_save_to_sd ? "SD + cloud" : "local (computer)");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, "OK", 2);
}

// ===========================================================================
// >>> SD / Firebase coder: implement this to write a JPEG to the SD card.
//     Return true on success; your auto-uploader then pushes it to Firebase.
//     Until it's implemented, "SD + Cloud" snapshots report "not wired yet".
// ===========================================================================
static bool cw_save_jpeg_to_sd(const uint8_t *buf, size_t len) {
  (void)buf; (void)len;
  return false;   // <-- replace with the real SD write (SD_MMC or SD over SPI)
}

// Snapshot straight to the SD card (used when the switch is on "SD + Cloud").
static esp_err_t capture_sd_handler(httpd_req_t *req) {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) { httpd_resp_send_500(req); return ESP_FAIL; }
  bool ok = cw_save_jpeg_to_sd(fb->buf, fb->len);
  esp_camera_fb_return(fb);
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  const char *msg = ok ? "SAVED" : "SD_NOT_WIRED";
  return httpd_resp_send(req, msg, strlen(msg));
}

static esp_err_t status_handler(httpd_req_t *req) {
  float tc = 0;
  if (temp_sensor) temperature_sensor_get_celsius(temp_sensor, &tc);

  time_t now = time(NULL);
  // The clock starts at epoch 0; once NTP sets it, "now" jumps past 2023.
  bool synced = (now > 1700000000);

  // UTC offset (incl. DST) computed portably: this toolchain has no tm_gmtoff.
  // The difference of the local vs. UTC broken-down times, both re-encoded with
  // the same DST flag, is exactly the current offset in seconds.
  struct tm lt, gt;
  localtime_r(&now, &lt);
  gmtime_r(&now, &gt);
  lt.tm_isdst = 0; gt.tm_isdst = 0;
  long tz_offset = (long)(mktime(&lt) - mktime(&gt));

  char json[400];
  int len = snprintf(json, sizeof(json),
    "{\"temp_c\":%.1f,\"temp_f\":%.1f,"
    "\"weather_c\":%.1f,\"weather_f\":%.1f,\"weather_ok\":%s,"
    "\"city\":\"%s\",\"located\":%s,\"lat\":%.5f,\"lon\":%.5f,"
    "\"save_to_sd\":%s,"
    "\"heap\":%u,\"uptime_s\":%lu,"
    "\"epoch\":%lld,\"tz_offset\":%ld,\"synced\":%s}",
    tc, tc * 9.0f / 5.0f + 32.0f,
    g_weather_c, g_weather_c * 9.0f / 5.0f + 32.0f, g_weather_ok ? "true" : "false",
    g_city.c_str(), g_located ? "true" : "false", g_lat, g_lon,
    g_save_to_sd ? "true" : "false",
    (unsigned)ESP.getFreeHeap(), (unsigned long)(millis() / 1000),
    (long long)now, tz_offset, synced ? "true" : "false");
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, json, len);
}

void startCameraServer() {
  // ---- Control/UI server on port 80 ----
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 80;
  config.ctrl_port = 32768;
  config.max_uri_handlers = 8;

  httpd_uri_t index_uri   = { .uri="/",        .method=HTTP_GET, .handler=index_handler,   .user_ctx=NULL };
  httpd_uri_t capture_uri = { .uri="/capture", .method=HTTP_GET, .handler=capture_handler, .user_ctx=NULL };
  httpd_uri_t control_uri = { .uri="/control", .method=HTTP_GET, .handler=control_handler, .user_ctx=NULL };
  httpd_uri_t status_uri  = { .uri="/status",  .method=HTTP_GET, .handler=status_handler,  .user_ctx=NULL };
  httpd_uri_t savemode_uri  = { .uri="/savemode",   .method=HTTP_GET, .handler=savemode_handler,   .user_ctx=NULL };
  httpd_uri_t capturesd_uri = { .uri="/capture_sd", .method=HTTP_GET, .handler=capture_sd_handler, .user_ctx=NULL };

  if (httpd_start(&camera_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(camera_httpd, &index_uri);
    httpd_register_uri_handler(camera_httpd, &capture_uri);
    httpd_register_uri_handler(camera_httpd, &control_uri);
    httpd_register_uri_handler(camera_httpd, &status_uri);
    httpd_register_uri_handler(camera_httpd, &savemode_uri);
    httpd_register_uri_handler(camera_httpd, &capturesd_uri);
  }

  // ---- Dedicated stream server on port 81 ----
  // Its blocking stream loop can't starve the control server above.
  httpd_config_t stream_config = HTTPD_DEFAULT_CONFIG();
  stream_config.server_port = 81;
  stream_config.ctrl_port = 32769;

  httpd_uri_t stream_uri = { .uri="/stream", .method=HTTP_GET, .handler=stream_handler, .user_ctx=NULL };

  if (httpd_start(&stream_httpd, &stream_config) == ESP_OK) {
    httpd_register_uri_handler(stream_httpd, &stream_uri);
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0       = Y2_GPIO_NUM;
  config.pin_d1       = Y3_GPIO_NUM;
  config.pin_d2       = Y4_GPIO_NUM;
  config.pin_d3       = Y5_GPIO_NUM;
  config.pin_d4       = Y6_GPIO_NUM;
  config.pin_d5       = Y7_GPIO_NUM;
  config.pin_d6       = Y8_GPIO_NUM;
  config.pin_d7       = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size   = FRAMESIZE_VGA;
  config.jpeg_quality = 12;
  config.fb_count     = 1;
  config.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location  = CAMERA_FB_IN_DRAM;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) { Serial.printf("Camera init failed: 0x%x\n", err); return; }
  Serial.println("Camera init OK");

  // Internal chip temperature sensor (die temperature, not ambient).
  temperature_sensor_config_t temp_cfg = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 120);
  if (temperature_sensor_install(&temp_cfg, &temp_sensor) == ESP_OK
      && temperature_sensor_enable(temp_sensor) == ESP_OK) {
    Serial.println("Temp sensor OK");
  } else {
    Serial.println("Temp sensor unavailable");
    temp_sensor = NULL;
  }

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.printf("\n\n>>> Open: http://%s/\n", WiFi.localIP().toString().c_str());

  // Sync the clock over NTP (needs internet). Non-blocking-ish: try for ~5s,
  // then carry on — sntp keeps retrying in the background once it's running.
  configTzTime(TIMEZONE, NTP_SERVER1, NTP_SERVER2);
  Serial.print("Syncing time via NTP");
  struct tm t;
  int tries = 0;
  while (!getLocalTime(&t, 1000) && tries < 5) { Serial.print("."); tries++; }
  if (tries < 5) Serial.printf(" set: %04d-%02d-%02d %02d:%02d:%02d\n",
                               t.tm_year + 1900, t.tm_mon + 1, t.tm_mday,
                               t.tm_hour, t.tm_min, t.tm_sec);
  else Serial.println(" no NTP yet (will keep retrying in background)");

  // Detect location from the public IP, then grab the current weather for it.
  locateDevice();
  fetchWeather();
  g_lastWeather = millis();

  startCameraServer();
}

void loop() {
  // Refresh the weather periodically. The camera + stream run on their own
  // tasks, so a brief blocking fetch here doesn't interrupt the video.
  if (millis() - g_lastWeather > WEATHER_REFRESH_MS) {
    g_lastWeather = millis();
    fetchWeather();
  }
  delay(1000);
}
