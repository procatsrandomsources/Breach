/* =========================================================================
   BREACH PROTOCOL — MULTIPLAYER
   Photon Realtime (lobby codes / quick match / state sync / voice chat)
   Voice uses WebRTC mesh signaled through Photon room events, so the single
   Realtime AppID is enough (Photon Voice JS needs a separate Voice AppID).
   ========================================================================= */
(function () {
'use strict';
const APPID = '18ded446-f4df-4ca3-aa64-9ec049865f76';
const $ = id => document.getElementById(id);
const EV = { STATE: 100, HIT: 101, FIRE: 102, BREACH: 103, CHAT: 104, VO: 105, VOA: 106, VOI: 107, HELLO: 108, ROUND: 109, DEPLOY: 110, ENDREQ: 111, DEATH: 113, HITACK: 114, COUNTDOWN: 115 };
const CODECH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

let lbc = null, conn = 'off', connNum = -1, sendT = 0, lobbyT = 0, mpTab = 'mp', regionIx = 0, everJoined = false;
const REGIONS = ['eu', 'us', 'asia'];
const MODES = [
  { id: '1v1', label: '1v1', max: 2, bots: 0 },
  { id: '2v2', label: '2v2', max: 4, bots: 2 },
  { id: '3v3', label: '3v3', max: 6, bots: 3 },
  { id: '4v4', label: '4v4', max: 8, bots: 4 }
];
let mpMode = MODES[3];
if (S.mpMode) { const m = MODES.find(x => x.id === S.mpMode); if (m) mpMode = m; }
let mySide = (S.mpSide === 'D' ? 'D' : 'A');
let mpScore = { A: 0, D: 0 }, mpRoundOver = false, mpEndSent = false, mpDeployed = {}, mpKills = {}, mpCountdown = 0;
const vc = { on: false, stream: null, pcs: {}, els: {} };

MP.match = false; MP.code = ''; MP.lobby = false;

/* ---------------- helpers ---------------- */
function me() { try { return lbc && lbc.myActor(); } catch (e) { return null; } }
function myNr() { const m = me(); return m ? m.actorNr : 0; }
function actors() { try { return lbc ? lbc.myRoomActorsArray() : []; } catch (e) { return []; } }
function isHost() { try { return !!(lbc && lbc.myRoom() && myNr() && myNr() === lbc.myRoomMasterActorNr()); } catch (e) { return false; } }
function mpName() { return ((S.mpName || '').trim()) || ('Player' + (myNr() || 1)); }
function actorName(a) { try { const p = a.getCustomProperties() || {}; return p.mpn || a.name || ('P' + a.actorNr); } catch (e) { return 'P' + a.actorNr; } }
function actorSide(a) { try { const p = a.getCustomProperties() || {}; return p.mps === 'D' ? 'D' : 'A'; } catch (e) { return 'A'; } }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function genCode() { let s = ''; for (let i = 0; i < 5; i++) s += CODECH[(Math.random() * CODECH.length) | 0]; return s; }
function feed(t) {
  const f = $('mpfeed'); if (!f) return;
  const d = document.createElement('div'); d.className = 'mpf'; d.textContent = t;
  f.appendChild(d); while (f.children.length > 6) f.removeChild(f.firstChild);
  setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 600); }, 7000);
}
function rpOf(nr) { return rpl.find(r => r.nr === nr) || null; }

/* ---------------- connection ---------------- */
function mpConnect() {
  if (lbc) {
    const D = Photon.LoadBalancing.LoadBalancingClient.State.Disconnected;
    if (connNum !== D && connNum !== -1) { feed('Already connected to Photon'); return; }
    try { lbc.disconnect(); } catch (e) {} lbc = null; connNum = -1; conn = 'off';
  }
  if (!window.Photon || !Photon.LoadBalancing) { feed('Photon SDK missing (photon.min.js)'); return; }
  const L = Photon.LoadBalancing;
  lbc = new L.LoadBalancingClient(Photon.ConnectionProtocol.Wss, APPID, '1.0');
  lbc.onStateChange = st => {
    connNum = st; conn = L.LoadBalancingClient.StateToName(st) || 'off';
    feed('Photon: ' + conn);
    if (st === L.LoadBalancingClient.State.Disconnected) {
      if (!everJoined && regionIx < REGIONS.length - 1 && lbc) {
        regionIx++; feed('Retrying region ' + REGIONS[regionIx] + '…');
        try { lbc.connectToRegionMaster(REGIONS[regionIx]); return; } catch (e) {}
      }
      mpDropped('Disconnected from Photon');
    }
    else if ((st === L.LoadBalancingClient.State.ConnectedToMaster || st === L.LoadBalancingClient.State.JoinedLobby) && !(lbc.myRoom && lbc.myRoom())) {
      if (MP.active) { MP.active = false; MP.match = false; MP.lobby = false; MP.code = ''; rpl.forEach(r => { try { scene.remove(r.g); } catch (e) {} }); rpl.length = 0; vcReset(); }
    }
    mpRenderPanel();
  };
  lbc.onError = (c, m) => {
    feed('Photon error ' + c + ': ' + m);
    if (c === L.Constants.ErrorCode.InvalidRegion && regionIx < REGIONS.length - 1) { regionIx++; try { lbc.connectToRegionMaster(REGIONS[regionIx]); } catch (e) {} }
  };
  lbc.onOperationResponse = (err, msg) => {
    const EC = L.Constants.ErrorCode;
    if (err === EC.NoRandomMatchFound) mpHostGame();
    else if (err === EC.GameDoesNotExist) feed('Room not found — check the code');
    else if (err === EC.GameFull) feed('That room is full');
    else if (err === EC.GameClosed) feed('That room is closed');
    else if (err === 32737) feed('Photon rejected room creation — check the App ID matches a Realtime app');
    else if (err !== EC.Ok) feed('Room error ' + err + (msg ? ': ' + msg : ''));
  };
  lbc.onJoinRoomFailed = (c, m) => feed('Join failed: ' + m);
  lbc.onJoinRoom = () => {
    everJoined = true;
    const rp = lbc.myRoom();
    if (rp && rp.customProperties && rp.customProperties.game !== 'bp') {
      feed('That is not a Breach Protocol room');
      try { lbc.leaveRoom(); } catch (e) {}
      return;
    }
    if (rp && rp.customProperties && rp.customProperties.mode) {
      const mo = MODES.find(m => m.id === rp.customProperties.mode);
      if (mo) mpMode = mo;
    }
    MP.active = true; MP.match = false; MP.lobby = true; MP.code = rp ? rp.name : '';
    setMyProps(); mpHello(); vcReset();
    feed('Joined room ' + MP.code);
    for (const a of actors()) if (!a.isLocal) onActorJoinNet(a);
    mpRenderPanel();
  };
  lbc.onActorJoin = a => { if (!a.isLocal) onActorJoinNet(a); };
  lbc.onActorLeave = (a, cl) => { dropRp(a.actorNr); feed(actorName(a) + ' left'); vcDrop(a.actorNr); mpRenderPanel(); };
  lbc.onActorPropertiesChange = a => { const r = rpOf(a.actorNr); if (r) { r.name = actorName(a); r.side = actorSide(a); paintTag(r, true); } mpRenderPanel(); };
  lbc.onEvent = (code, content, actorNr) => mpOnEvent(code, content, actorNr);
  regionIx = 0;
  try { lbc.connectToRegionMaster(REGIONS[0]); conn = 'connecting'; } catch (e) { feed('Connect failed: ' + e.message); }
  mpRenderPanel();
}
function setMyProps() { try { const m = me(); if (m) m.setCustomProperties({ mpn: mpName(), mps: mySide }); } catch (e) {} }
function mpHello() { try { lbc.raiseEvent(EV.HELLO, {}, {}); } catch (e) {} }
function mpQuick() {
  if (!lbc || (connNum !== Photon.LoadBalancing.LoadBalancingClient.State.ConnectedToMaster && connNum !== Photon.LoadBalancing.LoadBalancingClient.State.JoinedLobby)) { feed('Not connected yet'); return; }
  try { lbc.joinRandomRoom({ expectedCustomRoomProperties: { game: 'bp', mode: mpMode.id } }); feed('Searching for a match…'); }
  catch (e) { feed('Quick match failed: ' + e.message); }
}
function mpHostGame() {
  if (!lbc || (connNum !== Photon.LoadBalancing.LoadBalancingClient.State.ConnectedToMaster && connNum !== Photon.LoadBalancing.LoadBalancingClient.State.JoinedLobby)) { feed('Not connected yet'); return; }
  try { lbc.createRoom(genCode(), { maxPlayers: mpMode.max, isOpen: true, isVisible: true, customGameProperties: { game: 'bp', mode: mpMode.id } }); }
  catch (e) { feed('Host failed: ' + e.message); }
}
function mpJoin(code) {
  code = (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!lbc || (connNum !== Photon.LoadBalancing.LoadBalancingClient.State.ConnectedToMaster && connNum !== Photon.LoadBalancing.LoadBalancingClient.State.JoinedLobby)) { feed('Not connected yet'); return; }
  if (code.length < 4) { feed('Enter a room code'); return; }
  try { lbc.joinRoom(code); feed('Joining ' + code + '…'); }
  catch (e) { feed('Join failed: ' + e.message); }
}
function mpDropped(why) {
  MP.active = false; MP.match = false; MP.lobby = false; MP.code = '';
  rpl.forEach(r => { try { scene.remove(r.g); } catch (e) {} }); rpl.length = 0;
  vcReset();
  if (state === 'play') { state = 'menu'; try { document.exitPointerLock(); } catch (e) {} openMenu(); }
  feed(why || 'Disconnected'); mpRenderPanel();
}
function mpLeave() {
  try { if (lbc && MP.active) lbc.leaveRoom(); else if (lbc) lbc.disconnect(); } catch (e) {}
  if (!MP.active && lbc) { try { lbc.disconnect(); } catch (e) {} lbc = null; conn = 'off'; }
  MP.active = false; MP.match = false; MP.lobby = false; MP.code = '';
  rpl.forEach(r => { try { scene.remove(r.g); } catch (e) {} }); rpl.length = 0;
  vcReset(); mpDeployed = {}; mpRoundOver = false;
  if (state === 'play') { state = 'menu'; try { document.exitPointerLock(); } catch (e) {} }
  openMenu(); renderMenu('mp');
}
function onActorJoinNet(a) {
  ensureRp(a.actorNr); feed(actorName(a) + ' joined');
  if (vc.on) vcEnsure(a.actorNr, myNr() < a.actorNr);
  mpRenderPanel();
}

/* ---------------- remote player avatars ---------------- */
function ensureRp(nr) {
  let r = rpOf(nr); if (r) return r;
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(.55, 1.1, .3), M(0x888888)); body.position.y = .95;
  const head = new THREE.Mesh(new THREE.SphereGeometry(.17, 24, 16), SKIN); head.position.y = 1.72;
  const legs = new THREE.Mesh(new THREE.BoxGeometry(.4, .45, .25), M(0x2a2a2e)); legs.position.y = .22;
  g.add(body, head, legs);
  /* Add collider visualization (wireframe box) */
  const collider = new THREE.Mesh(
    new THREE.BoxGeometry(.6, 1.8, .4),
    new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true, transparent: true, opacity: 0 })
  );
  collider.position.y = .9;
  collider.visible = false;
  g.add(collider);
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
  const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv); tex.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, depthWrite: false }));
  sp.scale.set(1.7, .43, 1); sp.position.y = 2.15; sp.renderOrder = 5; g.add(sp);
  r = { nr, name: 'P' + nr, side: 'A', hp: 100, alive: true, isRP: true, g, body, head, legs, collider, ctx, tex, sp, lhp: -1, lname: '', tx: 0, ty: 1.6, tz: 22, tyaw: 0, stance: 0 };
  body.userData = { rp: r }; head.userData = { rp: r, head: 1 };
  g.visible = false; g.position.set(0, 1.6, 22); scene.add(g);
  rpl.push(r); paintTag(r, true); return r;
}
function dropRp(nr) {
  const i = rpl.findIndex(r => r.nr === nr); if (i < 0) return;
  const r = rpl[i]; try { scene.remove(r.g); } catch (e) {} rpl.splice(i, 1);
}
function paintTag(r, force) {
  const hpv = Math.max(0, r.hp | 0);
  if (!force && hpv === r.lhp && r.name === r.lname && r.side === r.lside) return;
  r.lhp = hpv; r.lname = r.name; r.lside = r.side;
  const c = r.ctx; c.clearRect(0, 0, 256, 64);
  c.font = '700 30px "Barlow Condensed", Arial, sans-serif'; c.textAlign = 'center';
  c.lineWidth = 5; c.strokeStyle = '#000';
  if (hpv <= 0) c.fillStyle = '#555';
  else c.fillStyle = r.side === 'A' ? '#8fc0ff' : '#ff9d9d';
  c.strokeText(r.name, 128, 34); c.fillText(r.name, 128, 34);
  c.fillStyle = '#000a'; c.fillRect(48, 42, 160, 12);
  if (hpv > 0) {
    c.fillStyle = hpv > 50 ? '#7cfc00' : hpv > 25 ? '#f2b705' : '#d7263d';
    c.fillRect(50, 44, 156 * Math.min(100, hpv) / 100, 8);
  } else {
    c.fillStyle = '#d7263d'; c.fillRect(50, 44, 156, 8);
  }
  r.tex.needsUpdate = true;
  if (r.g) r.g.visible = hpv > 0;
}
function mpSideCount(s) { let n = (mySide === s) ? 1 : 0; for (const r of rpl) if (r.side === s) n++; return n; }

/* bots pick the nearest living enemy-side player (self or remote) */
function mpTgt(b) {
  if (!MP.active || !MP.match) return { x: P.x, y: P.y, z: P.z, nr: 0 };
  let bx = P.x, by = P.y, bz = P.z, bnr = 0, bd = 1e9;
  if (hp > 0 && side !== b.side) { const d = Math.hypot(P.x - b.g.position.x, P.z - b.g.position.z); if (d < bd) { bd = d; bx = P.x; by = P.y; bz = P.z; bnr = 0; } }
  for (const r of rpl) {
    if (r.alive === false || r.side === b.side) continue;
    const d = Math.hypot(r.g.position.x - b.g.position.x, r.g.position.z - b.g.position.z);
    if (d < bd) { bd = d; bx = r.g.position.x; by = r.g.position.y + 1.4; bz = r.g.position.z; bnr = r.nr; }
  }
  return { x: bx, y: by, z: bz, nr: bnr };
}

/* ---------------- events ---------------- */
function mpOnEvent(code, c, a) {
  switch (code) {
    case EV.STATE: onState(c, a); break;
    case EV.HIT: onHit(c); break;
    case EV.FIRE: onFire(c, a); break;
    case EV.BREACH: onBreach(c); break;
    case EV.CHAT: feed((c.n || '?') + ': ' + (c.t || '')); break;
    case EV.HELLO: try { lbc.raiseEvent(EV.STATE, curState(), { targetActors: [a] }); } catch (e) {} break;
    case EV.ROUND: onRound(c); break;
    case EV.DEPLOY: mpDeployed[a] = 1; mpRenderPanel(); break;
    case EV.ENDREQ: if (isHost() && !mpRoundOver) mpRoundEnd(c.w, c.r); break;
    case EV.DEATH: {
      feed((c.k || 'Someone') + ' eliminated ' + (c.n || 'a player'));
      mpKills[c.n] = (mpKills[c.n] || 0) + 1;
      const r = rpOf(a);
      if (r) { r.hp = 0; r.alive = false; paintTag(r, true); }
      mpCheckElimination();
      break;
    }
    case EV.COUNTDOWN: onCountdown(c); break;
    case EV.VO: vcOnOffer(c, a); break;
    case EV.VOA: vcOnAnswer(c, a); break;
    case EV.VOI: vcOnIce(c, a); break;
  }
}
function curState() {
  return [P.x, P.y - eyeH, P.z, yaw, pitch, Math.max(0, Math.ceil(hp)), stance, slot, Lv, mpProt > 0 ? 1 : 0, mySide, mpMode.id, hp <= 0 ? 2 : 0];
}
function mpSendState() {
  if (!MP.active || !lbc) return;
  try { lbc.raiseEvent(EV.STATE, curState(), {}); } catch (e) {}
}
function onState(c, a) {
  if (a === myNr()) return;
  const r = ensureRp(a); if (!r || !c) return;
  r.tx = c[0]; r.ty = c[1]; r.tz = c[2]; r.tyaw = c[3];
  r.hp = c[5] == null ? 100 : c[5]; r.alive = r.hp > 0;
  r.side = c[10] === 'D' ? 'D' : 'A';
  if (c[11]) r.mode = c[11];
  /* If dead in 2v2, show prone stance */
  if (r.hp <= 0 && mpMode.id === '2v2') {
    r.stance = 2;
    r.ty = c[1] - 1.25; /* Lower position for prone */
  } else {
    r.stance = 0;
  }
  paintTag(r);
  if (MP.match && !r.g.visible) r.g.visible = true;
  const dx = r.tx - r.g.position.x, dz = r.tz - r.g.position.z;
  if (dx * dx + dz * dz > 64) { r.g.position.set(r.tx, r.ty, r.tz); r.g.rotation.y = r.tyaw; }
}
function onHit(c) {
  if (!MP.match || state !== 'play' || mpProt > 0) return;
  if (c.s && c.s === side) return; /* no friendly fire */
  if (hp <= 0) return;
  hp -= (c.d || 0) * (gdB.arm > 0 ? .7 : 1);
  $('dmg').style.opacity = 1; shake = Math.max(shake, .12); mpKiller = c.k || null;
  snd(110, .14, 'sine', .3, -60);
  if (hp <= 0) { hp = 0; mpDie(); }
  else try { lbc.raiseEvent(EV.HITACK, { hp: Math.round(hp) }, {}); } catch (e) {}
}
function mpHitPlayer(r, d, h, anySide) { /* called by game code when local player hits a remote */
  if (!MP.active || !r) return;
  if (!anySide && r.side === side) return; /* no friendly fire */
  const nr = r.nr != null ? r.nr : r;
  const hm = $('hm'); hm.style.opacity = 1; hm.style.borderColor = h ? '#d7263d' : hmc();
  setTimeout(() => hm.style.opacity = 0, 120); hitSnd(!!h, 0);
  if (r.hp > 0 && r.hp - d <= 0) {
    r.hp = 0; r.alive = false;
    /* Store stance for prone display in 2v2 */
    r.stance = (mpMode.id === '2v2') ? 2 : 0;
    paintTag(r, true);
    try { lbc.raiseEvent(EV.DEATH, { n: actorName(r), k: mpName(), s: r.side }, { targetActors: [nr] }); } catch (e) {}
  } else {
    try { lbc.raiseEvent(EV.HIT, { d: Math.round(d), h: h ? 1 : 0, k: mpName(), s: side }, { targetActors: [nr] }); } catch (e) {}
  }
}
function mpBotShot(nr, d) {
  try { lbc.raiseEvent(EV.HIT, { d: Math.round(d), h: 0, k: 'Bot' }, { targetActors: [nr] }); } catch (e) {}
}
function mpSendFire(fp) {
  if (!MP.active || !fp) return;
  try { lbc.raiseEvent(EV.FIRE, { e: [fp.x, fp.y, fp.z] }, {}); } catch (e) {}
}
function onFire(c, a) {
  const r = rpOf(a); if (!r || !c || !c.e) return;
  const from = r.g.position.clone(); from.y += 1.35;
  const to = new THREE.Vector3(c.e[0], c.e[1], c.e[2]);
  const L = from.distanceTo(to); if (L < .5) return;
  const m = new THREE.Mesh(new THREE.BoxGeometry(.014, .014, 1),
    new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: .9, depthWrite: false, toneMapped: false }));
  m.position.copy(from).lerp(to, .5); m.scale.z = L; m.lookAt(to); scene.add(m); trc.push({ m, l: .14 });
  const d = from.distanceTo(cam.position);
  snd(160, .09, 'square', Math.max(.02, .13 - d * .004), -60);
}
function mpSendBreach(k, pos) {
  if (!MP.active || !pos) return;
  try { lbc.raiseEvent(EV.BREACH, { k, p: [pos.x, pos.y, pos.z] }, {}); } catch (e) {}
}
function onBreach(c) {
  if (!c || !c.p) return; const p = c.p;
  if (c.k === 'd') { const d = doors.find(d => !d.dead && Math.hypot(d.x - p[0], d.z - p[2]) < 1.6); if (d) killDoor(d); }
  else if (c.k === 'h') { const h = hatches.find(h => !h.open && Math.hypot(h.x - p[0], h.z - p[2]) < 1.6); if (h) openHatch(h); }
  else {
    let best = null, bd = 1.6;
    for (const m of walls) { const u = m.userData; if (!(u.c && u.c.r)) continue; const dd = Math.hypot(m.position.x - p[0], m.position.z - p[2]); if (dd < bd) { bd = dd; best = m; } }
    if (best) { const u = best.userData; scene.remove(best); const wi = walls.indexOf(best); if (wi > -1) walls.splice(wi, 1); const ci = cols.indexOf(u.c); if (ci > -1) cols.splice(ci, 1); }
  }
}

/* ---------------- rounds ---------------- */
function mpRoundEnd(ws, reason) {
  if (mpRoundOver || mpEndSent) return;
  if (!isHost()) { mpEndSent = true; try { lbc.raiseEvent(EV.ENDREQ, { w: ws, r: reason }, { targetActors: [lbc.myRoomMasterActorNr()] }); } catch (e) {} return; }
  mpRoundOver = true; mpEndSent = true; mpScore[ws] = (mpScore[ws] || 0) + 1;
  const ev = { k: 'end', w: ws, r: reason, sA: mpScore.A, sD: mpScore.D };
  try { lbc.raiseEvent(EV.ROUND, ev, {}); } catch (e) {}
  mpShowEnd(ws, reason);
}

function onCountdown(c) {
  if (!c || !c.cd) return;
  const cdEl = $('mpcd');
  if (!cdEl) return;
  if (c.cd > 0) {
    cdEl.textContent = c.cd;
  } else {
    cdEl.textContent = 'GO!';
  }
}
function onRound(c) {
  if (!c) return;
  if (c.k === 'start') {
    rnd = c.rnd || 1; MAPI = c.map || 0; mpScore = { A: c.sA || 0, D: c.sD || 0 };
    if (c.mode) { const mo = MODES.find(m => m.id === c.mode); if (mo) mpMode = mo; }
    MP.match = true; MP.lobby = false; mpRoundOver = false; mpEndSent = false; mpDeployed = {};
    mySide = (S.mpSide === 'D' ? 'D' : 'A'); side = mySide;
    /* Reset all players for new round */
    rpl.forEach(r => { r.hp = 100; r.alive = true; r.stance = 0; r.g.visible = true; r.g.position.set(r.tx, r.ty, r.tz); paintTag(r, true); });
    hp = op ? op.hp : 100; stance = 0; eyeH = 1.6; mpProt = 0; mpKiller = null;
    /* Auto-start round, skip operator selection */
    mpDeployed = {};
    side = mySide;
    op = opFor(side);
    try { ren.domElement.requestPointerLock(); } catch (e) {}
    startRound(); state = 'play'; $('ov').style.display = 'none';
    mpDeployed[myNr()] = 1;
    try { lbc.raiseEvent(EV.DEPLOY, { n: mpName() }, {}); } catch (e) {}
    mpRenderPanel();
    feed('Round ' + rnd + ' started');
  } else if (c.k === 'end') {
    mpScore = { A: c.sA != null ? c.sA : mpScore.A, D: c.sD != null ? c.sD : mpScore.D };
    mpRoundOver = true; mpShowEnd(c.w, c.r);
  } else if (c.k === 'lobby') { mpToLobby(); }
}
function mpShowEnd(ws, reason) {
  state = 'end'; try { document.exitPointerLock(); } catch (e) {}
  const last = (rnd >= 6) || (mpScore.A >= 4 || mpScore.D >= 4);
  const winningTeam = mpScore.A > mpScore.D ? 'ATTACKERS' : (mpScore.D > mpScore.A ? 'DEFENDERS' : 'TIED');
  $('ovt').textContent = (ws === 'A' ? 'ATTACKERS' : 'DEFENDERS') + ' WIN' + (ws === side ? ' — YOUR SIDE' : '');
  $('ovb').innerHTML = 'Round ' + rnd + ' · ' + esc(reason || '') +
    '<br><br><b>MATCH SCORE:</b> Attackers <b>' + mpScore.A + '</b> — <b>' + mpScore.D + '</b> Defenders' +
    '<br><b>Leading:</b> ' + winningTeam +
    (last ? '<br><br><b>MATCH OVER</b>' : '<br><br><div id="mpcd" style="font-size:48px;font-weight:700;color:var(--hud)">5</div>');
  $('ops').innerHTML = ''; $('maps').innerHTML = ''; $('ld').innerHTML = ''; $('scope').style.display = 'none';
  const g = $('go'); g.style.display = 'none'; /* Hide deploy button */
  ovMode = 'mpresult'; $('ov').style.display = 'flex';

  if (!last && isHost()) {
    /* Start countdown for next round */
    mpCountdown = 5;
    const cdInt = setInterval(() => {
      const cdEl = $('mpcd');
      if (!cdEl) { clearInterval(cdInt); return; }
      mpCountdown--;
      if (mpCountdown > 0) {
        cdEl.textContent = mpCountdown;
        try { lbc.raiseEvent(EV.COUNTDOWN, { cd: mpCountdown }, {}); } catch (e) {}
      } else {
        clearInterval(cdInt);
        cdEl.textContent = 'GO!';
        try { lbc.raiseEvent(EV.COUNTDOWN, { cd: 0 }, {}); } catch (e) {}
        setTimeout(() => {
          rnd++;
          mpBroadcastStart(rnd);
        }, 500);
      }
    }, 1000);
  } else if (last && isHost()) {
    /* Match over, show back to lobby after delay */
    setTimeout(() => {
      mpBroadcast({ k: 'lobby' });
      mpToLobby();
    }, 3000);
  }
}
function mpToLobby() {
  MP.match = false; MP.lobby = true; mpRoundOver = false; mpEndSent = false; mpDeployed = {};
  rpl.forEach(r => { r.g.visible = false; r.hp = 100; r.alive = true; paintTag(r, true); });
  hp = op ? op.hp : 100; mpProt = 0; mpKiller = null;
  state = 'menu'; try { document.exitPointerLock(); } catch (e) {}
  openMenu(); renderMenu('mp'); feed('Back to lobby');
}
function mpBroadcast(ev) { try { lbc.raiseEvent(EV.ROUND, ev, {}); } catch (e) {} }
function mpGo() {
  AC = AC || new (window.AudioContext || window.webkitAudioContext)();
  if (ovMode === 'select') {
    side = mySide; op = opFor(side);
    mpDeployed = {}; mpProt = 3; mpKiller = null;
    try { ren.domElement.requestPointerLock(); } catch (e) {}
    startRound(); state = 'play'; $('ov').style.display = 'none';
    mpDeployed[myNr()] = 1;
    try { lbc.raiseEvent(EV.DEPLOY, { n: mpName() }, {}); } catch (e) {}
  }
  /* Removed mpresult handling - countdown auto-starts next round */
}
function mpBroadcastStart(r) {
  const map = MP.map == null ? MAPI : MP.map;
  const ev = { k: 'start', rnd: r, map, sA: mpScore.A, sD: mpScore.D, mode: mpMode.id };
  mpBroadcast(ev); onRound(ev);
}
function mpStartMatch() {
  if (!isHost()) { feed('Only the host can start'); return; }
  rnd = 1; mpScore = { A: 0, D: 0 };
  const map = MP.map == null ? MAPI : MP.map;
  const ev = { k: 'start', rnd: 1, map, sA: 0, sD: 0, mode: mpMode.id };
  try { lbc.myRoom().setMaxPlayers(mpMode.max); } catch (e) {}
  mpBroadcast(ev); onRound(ev);
}

function mpCheckElimination() {
  if (!MP.active || !MP.match || mpRoundOver) return;
  const aliveA = (hp > 0 ? 1 : 0) + rpl.filter(r => r.side === 'A' && r.hp > 0).length;
  const aliveD = rpl.filter(r => r.side === 'D' && r.hp > 0).length;
  const totalA = 1 + rpl.filter(r => r.side === 'A').length;
  const totalD = rpl.filter(r => r.side === 'D').length;
  const modeId = mpMode.id;
  /* Round ends when the ENTIRE team is eliminated */
  if (modeId === '1v1') {
    if (aliveA === 0) mpRoundEnd('D', 'Attacker eliminated');
    else if (aliveD === 0) mpRoundEnd('A', 'Defender eliminated');
  } else if (modeId === '2v2') {
    if (aliveA === 0) mpRoundEnd('D', 'Attackers eliminated');
    else if (aliveD === 0) mpRoundEnd('A', 'Defenders eliminated');
  } else {
    if (aliveA === 0) mpRoundEnd('D', 'Attackers eliminated');
    else if (aliveD === 0) mpRoundEnd('A', 'Defenders eliminated');
  }
}

/* death: elimination mode — no respawn, spectate until round ends */
function mpDie() {
  const k = mpKiller || null; mpKiller = null;
  feed(k ? (k + ' eliminated you') : 'You were eliminated');
  msg('ELIMINATED — SPECTATING');
  hp = 0;
  /* Show prone position when dead in 2v2, and show collider */
  stance = (mpMode.id === '2v2') ? 2 : 0;
  eyeH = (mpMode.id === '2v2') ? 0.35 : 1.6; /* Lower camera for prone */
  ads = false; reload = 0; fireT = 0;
  try { if (rap) { rap = null; ropeOff(); } } catch (e) {}
  try { document.exitPointerLock(); } catch (e) {}
  try { lbc.raiseEvent(EV.DEATH, { n: mpName(), k: k || 'Hostile', s: side }, {}); } catch (e) {}
  mpCheckElimination();
}

/* ---------------- per-frame ---------------- */
function mpTick(dt) {
  mpProt = Math.max(0, mpProt - dt);
  sendT -= dt;
  if (sendT <= 0) { sendT = 1 / 15; if (MP.active && MP.match && state === 'play') mpSendState(); }
  for (const r of rpl) {
    if (!r.g.visible) continue;
    const p = r.g.position, k = Math.min(1, dt * 10);
    p.x += (r.tx - p.x) * k; p.y += (r.ty - p.y) * k; p.z += (r.tz - p.z) * k;
    let dy = r.tyaw - r.g.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    r.g.rotation.y += dy * Math.min(1, dt * 10);
    /* Adjust body rotation for prone stance when dead in 2v2, show collider */
    if (r.hp <= 0 && mpMode.id === '2v2') {
      r.body.rotation.x = Math.PI / 2; /* Lie flat */
      r.head.position.y = 0.35; /* Lower head */
      r.legs.position.y = -0.3; /* Lower legs */
      if (r.collider) {
        r.collider.visible = true;
        r.collider.rotation.x = Math.PI / 2;
        r.collider.position.y = 0.35;
      }
    } else {
      r.body.rotation.x = 0;
      r.head.position.y = 1.72;
      r.legs.position.y = .22;
      if (r.collider) {
        r.collider.visible = false;
        r.collider.rotation.x = 0;
        r.collider.position.y = .9;
      }
    }
    paintTag(r);
  }
  lobbyT -= dt;
  if (lobbyT <= 0) { lobbyT = 1; if (mpTab === 'mp' && $('menu') && $('menu').style.display !== 'none' && document.activeElement.tagName !== 'INPUT') mpRenderPanel(); }
}

/* ---------------- chat ---------------- */
let chatOn = false;
function chatOpen() { const i = $('mpchatin'); chatOn = true; i.style.display = 'block'; i.value = ''; i.focus(); }
function chatClose() { const i = $('mpchatin'); chatOn = false; i.style.display = 'none'; i.blur(); }
function chatSend() {
  const i = $('mpchatin'), t = i.value.trim(); chatClose();
  if (!t || !MP.active) return;
  feed(mpName() + ': ' + t);
  try { lbc.raiseEvent(EV.CHAT, { t, n: mpName() }, {}); } catch (e) {}
}
document.addEventListener('keydown', e => {
  const ci = $('mpchatin');
  if (chatOn) {
    e.stopImmediatePropagation();
    if (e.target === ci) { if (e.code === 'Enter') chatSend(); else if (e.code === 'Escape') chatClose(); }
    return;
  }
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
  if (e.code === 'Enter' && MP.active && e.isTrusted) { e.preventDefault(); e.stopImmediatePropagation(); chatOpen(); }
  if (e.code === 'KeyN' && MP.active && e.isTrusted && !e.repeat) { vcToggle(); }
}, true);
document.addEventListener('keyup', e => { if (chatOn) e.stopImmediatePropagation(); }, true);
document.addEventListener('mousedown', e => { if (chatOn && e.target !== $('mpchatin')) e.stopImmediatePropagation(); }, true);

/* ---------------- voice (WebRTC mesh over Photon signaling) ---------------- */
function vcReset() { vcStop(true); }
function vcToggle() {
  if (!MP.active) { feed('Join a room to use voice'); return; }
  if (vc.on) { vcStop(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { feed('Voice needs a secure context (https or localhost)'); return; }
  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    .then(st => {
      vc.stream = st; vc.on = true; feed('Voice chat ON (press N to mute)');
      for (const a of actors()) if (!a.isLocal) vcEnsure(a.actorNr, myNr() < a.actorNr);
      mpRenderPanel();
    })
    .catch(e => feed('Mic blocked: ' + (e.message || e)));
}
function vcStop(silent) {
  vc.on = false;
  for (const nr in vc.pcs) { try { vc.pcs[nr].close(); } catch (e) {} delete vc.pcs[nr]; }
  for (const nr in vc.els) { try { vc.els[nr].remove(); } catch (e) {} delete vc.els[nr]; }
  if (vc.stream) { vc.stream.getTracks().forEach(t => t.stop()); vc.stream = null; }
  if (!silent) feed('Voice chat OFF');
}
function vcEnsure(nr, offer) {
  if (!vc.on || !vc.stream || vc.pcs[nr]) return;
  let pc; try { pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] }); }
  catch (e) { return; }
  vc.pcs[nr] = pc;
  vc.stream.getTracks().forEach(t => { try { pc.addTrack(t, vc.stream); } catch (e) {} });
  pc.onicecandidate = e => { if (e.candidate) { try { lbc.raiseEvent(EV.VOI, { c: e.candidate }, { targetActors: [nr] }); } catch (er) {} } };
  pc.ontrack = e => {
    let el = vc.els[nr];
    if (!el) { el = document.createElement('audio'); el.autoplay = true; el.playsInline = true; document.body.appendChild(el); vc.els[nr] = el; }
    el.srcObject = e.stream;
  };
  if (offer) pc.createOffer().then(o => { pc.setLocalDescription(o); lbc.raiseEvent(EV.VO, { s: o.sdp }, { targetActors: [nr] }); }).catch(() => {});
}
function vcOnOffer(c, a) {
  vcEnsure(a, false); const pc = vc.pcs[a]; if (!pc || !c || !c.s) return;
  pc.setRemoteDescription({ type: 'offer', sdp: c.s }).then(() => pc.createAnswer())
    .then(o => { pc.setLocalDescription(o); lbc.raiseEvent(EV.VOA, { s: o.sdp }, { targetActors: [a] }); }).catch(() => {});
}
function vcOnAnswer(c, a) { const pc = vc.pcs[a]; if (pc && c && c.s) pc.setRemoteDescription({ type: 'answer', sdp: c.s }).catch(() => {}); }
function vcOnIce(c, a) { const pc = vc.pcs[a]; if (pc && c && c.c) pc.addIceCandidate(c.c).catch(() => {}); }
function vcDrop(nr) { const pc = vc.pcs[nr]; if (pc) { try { pc.close(); } catch (e) {} delete vc.pcs[nr]; } const el = vc.els[nr]; if (el) { try { el.remove(); } catch (e) {} delete vc.els[nr]; } }

/* ---------------- UI ---------------- */
function mpRenderPanel() {
  const m = $('mmain'); if (!m) return;
  let h = '<h2>Multiplayer</h2>';
  h += '<label>Your name<input id="mpname" maxlength="20" value="' + esc(S.mpName || '') + '" placeholder="Player"><button data-mp="savename" style="margin-left:8px;padding:2px 10px">Save</button></label>';
  h += '<div class="tg"><button data-mp="sideA" class="' + (mySide === 'A' ? 'on' : '') + '">Attack</button><button data-mp="sideD" class="' + (mySide === 'D' ? 'on' : '') + '">Defend</button></div>';
  h += '<div class="tg">' + MODES.map(mo => '<button data-mp="mode' + mo.id + '" class="' + (mpMode.id === mo.id ? 'on' : '') + '">' + mo.label + '</button>').join('') + '</div>';
  h += '<p style="opacity:.8;font-size:16px">Attackers breach the walls and defuse the device. Defenders hold the building. Bots fill the empty spots on each side.</p>';
  if (!lbc || conn === 'off') { h += '<p>Connect to Photon to play online.</p><button class="btn" data-mp="connect">Connect</button>'; m.innerHTML = h; return; }
  if (!MP.active) {
    h += '<p>Photon: ' + esc(conn) + '</p>';
    if (connNum === Photon.LoadBalancing.LoadBalancingClient.State.ConnectedToMaster || connNum === Photon.LoadBalancing.LoadBalancingClient.State.JoinedLobby) {
      h += '<div class="lr"><button class="btn" data-mp="quick">Quick match</button><button class="btn" data-mp="host">Host game</button></div>';
      h += '<div class="lr"><input id="mpcode" maxlength="6" placeholder="ROOM CODE" style="width:110px;text-transform:uppercase;letter-spacing:.15em"><button class="btn" data-mp="join">Join</button></div>';
      h += '<p style="opacity:.7;font-size:15px">Quick match fills the first open room or creates one. Host game gives you a 5-letter code to share.</p>';
    } else h += '<p>Connecting…</p>';
    m.innerHTML = h; return;
  }
  h += '<p>Room code: <b style="font-size:26px;color:var(--hud);letter-spacing:.2em">' + MP.code + '</b> · ' + actors().length + '/' + mpMode.max + ' · ' + mpMode.label + '</p>';
  h += '<div style="margin:8px 0">' + actors().map(a => {
    const p = a.getCustomProperties() || {};
    const nm = p.mpn || a.name || ('P' + a.actorNr);
    const sd = (p.mps || 'A') === 'D' ? 'DEFEND' : 'ATTACK';
    const tag = (a.actorNr === myNr() ? ' (you)' : '') + (mpDeployed[a.actorNr] ? ' · deployed' : '');
    const vcTag = vc.pcs[a.actorNr] ? ' · 🔊' : '';
    return '<div style="padding:3px 0;border-bottom:1px solid #ffffff18"><b>' + esc(nm) + '</b> <small style="opacity:.75">' + sd + tag + vcTag + '</small></div>';
  }).join('') + '</div>';
  if (MP.match) {
    h += '<p><b>Match in progress</b> — round ' + rnd + ', score ' + mpScore.A + '-' + mpScore.D + '.</p>';
    h += '<button class="btn ghost" data-mp="voice">' + (vc.on ? 'Voice: ON' : 'Voice: OFF') + '</button> ';
    h += '<button class="btn ghost" data-mp="leave">Leave match</button>';
  } else {
    if (isHost()) {
      h += '<label>Map<select id="mpmap">' + MAPS.map((x, i) => '<option value="' + i + '"' + (i === (MP.map == null ? MAPI : MP.map) ? ' selected' : '') + '>' + x.n + '</option>').join('') + '</select></label>';
      h += '<button class="btn" data-mp="start">Start match</button> ';
    } else h += '<p>Waiting for the host to start…</p>';
    h += '<button class="btn ghost" data-mp="voice">' + (vc.on ? 'Voice: ON' : 'Voice: OFF') + '</button> ';
    h += '<button class="btn ghost" data-mp="leave">Leave room</button>';
    h += '<p style="opacity:.7;font-size:15px;margin-top:10px">Voice: press <b>N</b> in game or use the button. Chat: <b>Enter</b>. Press <b>Tab</b> for the scoreboard.</p>';
  }
  m.innerHTML = h;
  const ni = $('mpname'); if (ni) {
    ni.onchange = () => { S.mpName = ni.value.trim(); save(); setMyProps(); mpRenderPanel(); };
    ni.onkeydown = e => { if (e.code === 'Enter') { e.preventDefault(); ni.blur(); } };
  }
  const ni2 = $('mpname'); if (ni2) ni2.value = S.mpName || '';
  const ms = $('mpmap'); if (ms) ms.onchange = () => { MP.map = +ms.value; };
}
function mpAction(a) {
  if (a === 'connect') mpConnect();
  else if (a === 'quick') mpQuick();
  else if (a === 'host') mpHostGame();
  else if (a === 'join') { const c = $('mpcode'); mpJoin(c ? c.value : ''); }
  else if (a === 'leave') mpLeave();
  else if (a === 'start') mpStartMatch();
  else if (a === 'voice') vcToggle();
  else if (a === 'sideA' || a === 'sideD') { mySide = a === 'sideA' ? 'A' : 'D'; S.mpSide = mySide; save(); setMyProps(); mpRenderPanel(); }
  else if (a === 'savename') { const ni = $('mpname'); if (ni) { S.mpName = ni.value.trim(); save(); setMyProps(); mpRenderPanel(); } }
  else { const mo = MODES.find(m => a === 'mode' + m.id); if (mo) { mpMode = mo; S.mpMode = mo.id; save(); setMyProps(); mpRenderPanel(); } }
}

/* ---------------- hook into the game ---------------- */
const _end = end;
end = function (win, t) {
  if (!MP.active || !MP.match) return _end(win, t);
  const r = t || ''; let ws;
  if (/enemy defused|defused/.test(r)) ws = 'A';
  else if (/held the line|Time expired/.test(r)) ws = 'D';
  else ws = win ? (side === 'A' ? 'A' : 'D') : (side === 'A' ? 'D' : 'A');
  mpRoundEnd(ws, r);
};
const _go = $('go').onclick;
$('go').onclick = function (e) {
  if (MP.active && MP.match && (ovMode === 'select' || ovMode === 'mpresult')) { mpGo(); return; }
  return _go(e);
};
const _so = showOv;
showOv = function (m) { _so(m); if (MP.active && MP.match && m === 'select') $('maps').innerHTML = ''; };
const _rm = renderMenu;
renderMenu = function (t) {
  mpTab = t;
  document.querySelectorAll('#mside button[data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  if (t === 'mp') { updGold && updGold(); mpRenderPanel(); return; }
  _rm(t);
};
const _sb = sbRender;
sbRender = function () {
  if (!MP.active || !MP.match) return _sb();
  const e = $('sbd'), mm = Math.max(0, Math.ceil(time));
  let r = '<h3>SCOREBOARD</h3><div>Round ' + rnd + ' · Attack ' + mpScore.A + ' — ' + mpScore.D + ' Defend · ' + Math.floor(mm / 60) + ':' + String(mm % 60).padStart(2, '0') + '</div><table><tr><th>Player</th><th>Side</th><th>Kills</th><th>Status</th></tr>';
  r += '<tr class="me"><td>You (' + esc(mpName()) + ')</td><td>' + (side === 'A' ? 'ATTACK' : 'DEFEND') + '</td><td>' + (mpKills[mpName()] || 0) + '</td><td>' + (hp > 0 ? 'HP ' + Math.round(hp) : 'ELIMINATED') + '</td></tr>';
  for (const a of actors()) {
    if (a.isLocal) continue;
    const rn = rpOf(a.actorNr), p = a.getCustomProperties() || {};
    const nm = p.mpn || a.name || ('P' + a.actorNr);
    r += '<tr><td>' + esc(nm) + '</td><td>' + ((p.mps || 'A') === 'D' ? 'DEFEND' : 'ATTACK') + '</td><td>' + (mpKills[nm] || 0) + '</td><td>' + (rn ? (rn.hp > 0 ? 'HP ' + Math.round(rn.hp) : 'ELIMINATED') : '—') + '</td></tr>';
  }
  const en = side === 'A' ? 'Defender' : 'Attacker';
  bots.forEach((b, i) => { if (b.side === side) return; r += '<tr' + (b.alive ? '' : ' class="dead"') + '><td>' + en + ' ' + (i + 1) + '</td><td>BOT</td><td>–</td><td>' + (b.alive ? 'ALIVE' : 'ELIMINATED') + '</td></tr>'; });
  e.innerHTML = r + '</table>';
};
const _gt = gTick;
gTick = function (dt) { _gt(dt); mpTick(dt); };

/* ---------------- DOM ---------------- */
(function dom() {
  const feedEl = document.createElement('div'); feedEl.id = 'mpfeed'; document.body.appendChild(feedEl);
  const ci = document.createElement('input'); ci.id = 'mpchatin'; ci.maxLength = 120; ci.placeholder = 'Say something… (Enter to send, Esc to cancel)'; document.body.appendChild(ci);
  const vb = document.createElement('button'); vb.id = 'mpvbtn'; vb.textContent = 'MIC'; vb.title = 'Toggle voice chat (N)'; document.body.appendChild(vb);
  const st = document.createElement('style');
  st.textContent = '#mpfeed{position:fixed;left:22px;bottom:120px;z-index:25;font:500 16px/1.4 "Barlow Condensed",Arial,sans-serif;color:var(--ink);text-shadow:0 1px 3px #000;pointer-events:none;max-width:340px}' +
    '.mpf{background:var(--panel);padding:2px 10px;margin-top:4px;border-left:4px solid var(--hud);transition:opacity .6s}' +
    '#mpchatin{position:fixed;left:50%;bottom:120px;transform:translateX(-50%);z-index:60;display:none;width:min(480px,80vw);background:#0b0d12ee;border:1px solid var(--hud);color:var(--ink);font:500 18px "Barlow Condensed",Arial,sans-serif;padding:8px 12px;outline:none}' +
    '#mpvbtn{position:fixed;right:22px;top:70px;z-index:25;display:none;font:700 16px "Barlow Condensed",Arial,sans-serif;background:var(--panel);color:var(--ink);border:2px solid #fff4;padding:6px 12px;cursor:pointer}' +
    '#mpvbtn.on{border-color:var(--hud);color:var(--hud)}';
  document.head.appendChild(st);
  vb.onclick = () => vcToggle();
  setInterval(() => { vb.style.display = (MP.active && state === 'play') ? 'block' : 'none'; vb.classList.toggle('on', vc.on); }, 500);
  const mb = document.createElement('button'); mb.dataset.t = 'mp'; mb.textContent = 'Multiplayer';
  mb.onclick = () => { renderMenu('mp'); };
  const pl = $('pl'); if (pl && pl.nextSibling) $('mside').insertBefore(mb, pl.nextSibling); else $('mside').appendChild(mb);
  $('mmain').addEventListener('click', e => { const d = e.target.dataset; if (d && d.mp) mpAction(d.mp); });
})();

/* functions the game script calls directly — must live on the global object */
Object.assign(window, { mpTgt, mpDie, mpHitPlayer, mpBotShot, mpSendFire, mpSendBreach, mpSideCount, mpBotFill: () => mpMode.bots, mpCheckElimination });
})();
