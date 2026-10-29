# Drives Photoshop's Edit > Fill > Content-Aware over the cases through COM.
# Opens only the test files, and closes each without saving it; results are
# saved as copies into the output folder. Never touches the clipboard.
#   powershell -File photoshop-fill.ps1 -CasesDir <dir> -OutDir <dir> [-Only <substring>]
param([string]$CasesDir, [string]$OutDir, [string]$Only = '')
# Photoshop resolves paths against its own working folder, so hand it absolute ones.
$CasesDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($CasesDir)
$OutDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutDir)

$cases = Get-ChildItem $CasesDir -Directory |
  Where-Object { (Test-Path (Join-Path $_.FullName 'case.json')) -and ($Only -eq '' -or $_.Name -like "*$Only*") } |
  Sort-Object Name
$entries = foreach ($c in $cases) {
  $od = Join-Path $OutDir $c.Name
  New-Item -ItemType Directory -Force $od | Out-Null
  $f = { param($p) ($p -replace '\\', '/') }
  $maskFile = if (Test-Path (Join-Path $c.FullName 'mask-run.png')) { 'mask-run.png' } else { 'mask.png' }
  "{id:'$($c.Name)', img:'$(& $f (Join-Path $c.FullName 'image.png'))', mask:'$(& $f (Join-Path $c.FullName $maskFile))', out:'$(& $f (Join-Path $od 'photoshop.png'))', json:'$(& $f (Join-Path $od 'photoshop.json'))'}"
}

$jsx = @"
#target photoshop
app.displayDialogs = DialogModes.NO;
var cases = [
$($entries -join ",`n")
];
function writeText(path, text) { var f = File(path); f.encoding = 'UTF-8'; f.open('w'); f.write(text); f.close(); }
function contentAwareFill() {
  var d = new ActionDescriptor();
  d.putEnumerated(stringIDToTypeID('using'), stringIDToTypeID('fillContents'), stringIDToTypeID('contentAware'));
  d.putBoolean(stringIDToTypeID('contentAwareColorAdaptationFill'), true);
  d.putUnitDouble(stringIDToTypeID('opacity'), stringIDToTypeID('percentUnit'), 100);
  d.putEnumerated(stringIDToTypeID('mode'), stringIDToTypeID('blendMode'), stringIDToTypeID('normal'));
  executeAction(stringIDToTypeID('fill'), d, DialogModes.NO);
}
var log = [];
for (var i = 0; i < cases.length; i++) {
  var c = cases[i], img = null, m = null;
  var t0 = new Date().getTime();
  try {
    img = app.open(File(c.img));
    m = app.open(File(c.mask));
    if (m.mode != DocumentMode.GRAYSCALE) m.changeMode(ChangeMode.GRAYSCALE);
    m.channels[0].duplicate(img);
    m.close(SaveOptions.DONOTSAVECHANGES); m = null;
    app.activeDocument = img;
    var ch = img.channels[img.channels.length - 1];
    if (ch.kind == ChannelType.COMPONENT) throw new Error('mask channel did not arrive');
    // Duplicating leaves the alpha channel as the only active one; the fill
    // must target the picture, so make the colour channels active again.
    img.activeChannels = img.componentChannels;
    img.selection.load(ch, SelectionType.REPLACE);
    var sb = img.selection.bounds;
    if (Number(sb[2]) - Number(sb[0]) < 1) throw new Error('empty selection');
    var t1 = new Date().getTime();
    contentAwareFill();
    var fillMs = new Date().getTime() - t1;
    img.selection.deselect();
    ch.remove();
    img.saveAs(File(c.out), new PNGSaveOptions(), true, Extension.LOWERCASE);
    img.close(SaveOptions.DONOTSAVECHANGES); img = null;
    writeText(c.json, '{"engine":"photoshop","ms":' + fillMs + ',"totalMs":' + (new Date().getTime() - t0) + ',"version":"' + app.version + '"}');
    log.push(c.id + ' ok fill ' + fillMs + 'ms');
  } catch (e) {
    log.push(c.id + ' ERROR ' + e);
    writeText(c.json, '{"engine":"photoshop","error":"' + String(e).replace(/"/g, "'") + '"}');
    try { if (m) m.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {}
    try { if (img) img.close(SaveOptions.DONOTSAVECHANGES); } catch (e3) {}
  }
}
log.join('\n');
"@

$jsxPath = Join-Path $OutDir 'ps-fill.jsx'
Set-Content -Path $jsxPath -Value $jsx -Encoding UTF8
$ps = New-Object -ComObject Photoshop.Application
$ps.DoJavaScriptFile($jsxPath)
