-- TrioDurum: tells the Trio desktop app your character's level and zone.
--
-- An addon can do no network or file I/O. Two ways data leaves the game:
--   1. the chat log (Logs/WoWChatLog.txt, written while /chatlog is on): the
--      addon sends a one-line status message that the game logs; by default a
--      whisper to yourself (see CONTRACT-V5.md, "Why a whisper to yourself");
--   2. SavedVariables (TrioDurumDB), written by the game at logout and /reload.
-- The desktop app reads only lines starting with "TRIO1;" from the first and
-- the TrioDurumDB table from the second.
--
-- Line:  TRIO1;<seq>;<unix time>;<name>;<realm>;<level>;<classToken>;<zone>;<subzone>;<kind>
-- Fields are percent-encoded (% ; | \ and control bytes); UTF-8 is kept as is.
-- kind: login | zone | level | beat | logout | test
--
-- Every API is feature-detected: the same file runs on Classic-era and modern
-- (Midnight / Forever) clients, and under a plain Lua 5.1 test harness.

local ADDON_NAME, ns = ...
ns = ns or {}

local PREFIX = "TRIO1;"
local MAX_BYTES = 255 -- the chat message limit
local HEARTBEAT_SECONDS = 240
local DEBOUNCE_SECONDS = 2
local MIN_GAP_SECONDS = 10 -- between two automatic lines
local BUCKET_SIZE = 12 -- at most this many automatic lines ...
local BUCKET_SECONDS = 600 -- ... per this many seconds
local TICK_SECONDS = 5
local DEFAULT_CHANNEL = "TrioDurum"

local MODES = { whisper = true, channel = true, off = true }
local MODE_ALIASES = {
  ["fısıltı"] = "whisper", fisilti = "whisper", whisper = "whisper", ["fisıltı"] = "whisper",
  kanal = "channel", channel = "channel",
  ["kapalı"] = "off", kapali = "off", off = "off",
}
local MODE_LABELS = { whisper = "fısıltı", channel = "kanal", off = "kapalı" }

-- ------------------------------------------------------------ helpers

local G = _G

local function now()
  if type(G.time) == "function" then return G.time() end
  if type(G.GetServerTime) == "function" then return G.GetServerTime() end
  return 0
end

local function safeString(value)
  if value == nil then return "" end
  if type(G.issecretvalue) == "function" and G.issecretvalue(value) then return "" end
  if type(value) ~= "string" then value = tostring(value) end
  return value
end

--- Percent-encode the bytes that would break the frame or the chat line.
local function encodeField(value)
  value = safeString(value)
  return (string.gsub(value, "[%%;|\\%c]", function(c)
    return string.format("%%%02X", string.byte(c))
  end))
end
ns.encodeField = encodeField

--- Cut a UTF-8 string to at most `limit` bytes without splitting a character.
local function utf8Cut(value, limit)
  if #value <= limit then return value end
  local cut = limit
  -- Step back over continuation bytes (10xxxxxx) to a character start.
  while cut > 0 do
    local b = string.byte(value, cut + 1)
    if b == nil or b < 0x80 or b >= 0xC0 then break end
    cut = cut - 1
  end
  return string.sub(value, 1, cut)
end
ns.utf8Cut = utf8Cut

-- ------------------------------------------------------------ state

local db -- TrioDurumDB once ADDON_LOADED fired
local state = {
  pendingKind = nil, -- a change waiting for the debounce or the rate limit
  pendingAt = 0, -- when it may go out (debounce)
  lastSentAt = -math.huge,
  lastBeatAt = -math.huge,
  sentTimes = {}, -- automatic sends inside BUCKET_SECONDS
  lastError = nil,
  lastLevel = nil,
}
ns.state = state

local function defaults()
  db = G.TrioDurumDB
  if type(db) ~= "table" then
    db = {}
    G.TrioDurumDB = db
  end
  if not MODES[db.mode] then db.mode = "whisper" end
  if db.hide == nil then db.hide = true end
  if db.autolog == nil then db.autolog = true end
  if type(db.channel) ~= "string" or db.channel == "" then db.channel = DEFAULT_CHANNEL end
  if type(db.seq) ~= "number" then db.seq = 0 end
  return db
end
ns.defaults = defaults
ns.db = function() return db end

local function chat(text)
  local frame = G.DEFAULT_CHAT_FRAME
  if frame and frame.AddMessage then
    frame:AddMessage("|cffee997fTrio:|r " .. text)
  elseif type(G.print) == "function" then
    G.print("Trio: " .. text)
  end
end
ns.chat = chat

-- ------------------------------------------------------------ reading the character

local function playerName()
  if type(G.UnitName) == "function" then
    local name = G.UnitName("player")
    if name then return safeString(name) end
  end
  return ""
end

local function realmName()
  if type(G.GetRealmName) == "function" then return safeString(G.GetRealmName()) end
  return ""
end

local function zoneNames()
  local zone, subzone = "", ""
  if type(G.GetRealZoneText) == "function" then zone = safeString(G.GetRealZoneText()) end
  if zone == "" and type(G.GetZoneText) == "function" then zone = safeString(G.GetZoneText()) end
  if zone == "" and G.C_Map and G.C_Map.GetBestMapForUnit and G.C_Map.GetMapInfo then
    local ok, id = pcall(G.C_Map.GetBestMapForUnit, "player")
    if ok and id then
      local okInfo, info = pcall(G.C_Map.GetMapInfo, id)
      if okInfo and type(info) == "table" then zone = safeString(info.name) end
    end
  end
  if type(G.GetSubZoneText) == "function" then subzone = safeString(G.GetSubZoneText()) end
  if subzone == zone then subzone = "" end
  return zone, subzone
end

local function snapshot(kind)
  local level = state.lastLevel
  if level == nil and type(G.UnitLevel) == "function" then level = G.UnitLevel("player") end
  local classToken = ""
  if type(G.UnitClass) == "function" then
    local _, token = G.UnitClass("player")
    classToken = safeString(token)
  end
  local zone, subzone = zoneNames()
  return {
    name = playerName(),
    realm = realmName(),
    level = tonumber(level) or 0,
    class = classToken,
    zone = zone,
    subzone = subzone,
    kind = kind,
  }
end
ns.snapshot = snapshot

--- The line for a snapshot, at most MAX_BYTES bytes.
local function buildLine(seq, t, s)
  local limits = { name = 64, realm = 64, zone = 96, subzone = 96 }
  local line
  for _ = 1, 8 do
    line = table.concat({
      "TRIO1", tostring(seq), tostring(t),
      encodeField(utf8Cut(s.name, limits.name)),
      encodeField(utf8Cut(s.realm, limits.realm)),
      tostring(s.level), encodeField(s.class),
      encodeField(utf8Cut(s.zone, limits.zone)),
      encodeField(utf8Cut(s.subzone, limits.subzone)),
      s.kind,
    }, ";")
    if #line <= MAX_BYTES then return line end
    -- Too long (encoding can triple a byte): shrink subzone first, then zone.
    if limits.subzone > 0 then
      limits.subzone = math.max(0, limits.subzone - 32)
    else
      limits.zone = math.max(0, limits.zone - 24)
      limits.realm = math.max(0, limits.realm - 16)
    end
  end
  return string.sub(line, 1, MAX_BYTES)
end
ns.buildLine = buildLine

-- ------------------------------------------------------------ sending

local function sendChat(text, chatType, target)
  local send
  if G.C_ChatInfo and type(G.C_ChatInfo.SendChatMessage) == "function" then
    send = G.C_ChatInfo.SendChatMessage
  elseif type(G.SendChatMessage) == "function" then
    send = G.SendChatMessage
  end
  if not send then return false, "no SendChatMessage" end
  local ok, err = pcall(send, text, chatType, nil, target)
  if not ok then return false, tostring(err) end
  return true
end

local function inLockdown()
  local info = G.C_ChatInfo
  if info and type(info.InChatMessagingLockdown) == "function" then
    local ok, locked = pcall(info.InChatMessagingLockdown)
    return ok and locked == true
  end
  return false
end
ns.inLockdown = inLockdown

local function channelNumber()
  if type(G.GetChannelName) ~= "function" then return nil end
  local id = G.GetChannelName(db.channel)
  if type(id) == "number" and id > 0 then return id end
  return nil
end

local function joinChannel()
  if type(G.JoinChannelByName) ~= "function" then return end
  if channelNumber() then return end
  pcall(G.JoinChannelByName, db.channel, db.channelPassword)
end

--- Send one status line now through the chosen transport. Returns ok, why.
local function transmit(line)
  if db.mode == "off" then return false, "mod kapalı" end
  if inLockdown() then return false, "sohbet kilidi (zindan/karşılaşma)" end
  if db.mode == "channel" then
    local id = channelNumber()
    if not id then
      joinChannel()
      id = channelNumber()
    end
    if not id then return false, "kanala girilemedi: " .. db.channel end
    return sendChat(line, "CHANNEL", id)
  end
  local target = db.target
  if type(target) ~= "string" or target == "" then target = playerName() end
  if target == "" then return false, "karakter adı yok" end
  return sendChat(line, "WHISPER", target)
end

--- Record the status (always) and send it (when the transport allows).
local function emit(kind)
  local s = snapshot(kind)
  if s.name == "" then return false, "karakter adı yok" end
  db.seq = (db.seq or 0) + 1
  local t = now()
  local line = buildLine(db.seq, t, s)
  db.last = {
    seq = db.seq, time = t, name = s.name, realm = s.realm, level = s.level,
    class = s.class, zone = s.zone, subzone = s.subzone, kind = kind, line = line,
  }
  local ok, why = transmit(line)
  db.last.sent = ok and true or false
  state.lastError = (not ok) and why or nil
  return ok, why, line
end
ns.emit = emit

local function pruneBucket(t)
  local kept = {}
  for _, at in ipairs(state.sentTimes) do
    if t - at < BUCKET_SECONDS then kept[#kept + 1] = at end
  end
  state.sentTimes = kept
end

--- True when an automatic line may go out at time `t`.
local function allowed(t)
  pruneBucket(t)
  return t - state.lastSentAt >= MIN_GAP_SECONDS and #state.sentTimes < BUCKET_SIZE
end
ns.allowed = allowed

local PRIORITY = { beat = 1, zone = 2, level = 3, login = 4 }

--- Ask for an automatic line of `kind`; it goes out after the debounce and
--- within the rate limit. A stronger kind replaces a weaker pending one.
local function request(kind, delay)
  local t = now()
  if state.pendingKind == nil or (PRIORITY[kind] or 0) >= (PRIORITY[state.pendingKind] or 0) then
    state.pendingKind = kind
  end
  state.pendingAt = math.max(state.pendingAt or 0, t + (delay or 0))
end
ns.request = request

--- One tick: send what is pending (or a heartbeat) when allowed.
local function tick()
  if not db then return end
  local t = now()
  if state.pendingKind == nil and t - state.lastBeatAt >= HEARTBEAT_SECONDS then
    state.pendingKind = "beat"
    state.pendingAt = t
  end
  if state.pendingKind == nil or t < state.pendingAt then return end
  if not allowed(t) then return end
  if inLockdown() then return end -- keep it pending; try again next tick
  local kind = state.pendingKind
  state.pendingKind = nil
  state.pendingAt = 0
  emit(kind)
  state.lastSentAt = t
  state.lastBeatAt = t
  state.sentTimes[#state.sentTimes + 1] = t
end
ns.tick = tick

-- ------------------------------------------------------------ hiding our own lines

local function isOurs(msg)
  if type(msg) ~= "string" then return false end
  if type(G.issecretvalue) == "function" and G.issecretvalue(msg) then return false end
  return string.sub(msg, 1, #PREFIX) == PREFIX
end

local function filter(_, _, msg)
  if db and db.hide and isOurs(msg) then return true end
  return false
end
ns.filter = filter

local FILTER_EVENTS = { "CHAT_MSG_WHISPER", "CHAT_MSG_WHISPER_INFORM", "CHAT_MSG_CHANNEL" }

local function installFilters()
  local add = (G.ChatFrameUtil and G.ChatFrameUtil.AddMessageEventFilter)
    or G.ChatFrame_AddMessageEventFilter
  if type(add) ~= "function" then return false end
  for _, event in ipairs(FILTER_EVENTS) do pcall(add, event, filter) end
  return true
end
ns.installFilters = installFilters

-- ------------------------------------------------------------ chat log

local function loggingOn()
  if type(G.LoggingChat) ~= "function" then return nil end
  local ok, on = pcall(G.LoggingChat)
  if not ok then return nil end
  return on and true or false
end
ns.loggingOn = loggingOn

local function ensureLogging()
  if not db.autolog then return end
  if loggingOn() == false then
    pcall(G.LoggingChat, true)
    if loggingOn() then chat("sohbet kaydı açıldı (Logs/WoWChatLog.txt).") end
  end
end
ns.ensureLogging = ensureLogging

-- ------------------------------------------------------------ slash commands

local function trim(s) return (string.gsub(s or "", "^%s*(.-)%s*$", "%1")) end

local function printStatus()
  local log = loggingOn()
  chat("mod: " .. MODE_LABELS[db.mode] .. " · sohbet kaydı: "
    .. (log == nil and "bilinmiyor" or (log and "açık" or "KAPALI"))
    .. " · gizle: " .. (db.hide and "açık" or "kapalı")
    .. (db.mode == "channel" and (" · kanal: " .. db.channel) or ""))
  if db.last then
    chat("son satır (" .. (db.last.sent and "gönderildi" or "gönderilmedi") .. "): " .. tostring(db.last.line))
  else
    chat("henüz satır yok.")
  end
  if state.lastError then chat("son hata: " .. state.lastError) end
end

local HELP = {
  "/trio durum — son gönderilen satır, kayıt açık mı",
  "/trio test — hemen bir satır gönder",
  "/trio mod fısıltı | kanal | kapalı — nasıl gönderilsin",
  "/trio gizle açık | kapalı — kendi satırlarını sohbette gizle",
  "/trio kayıt açık | kapalı — sohbet kaydını kendiliğinden aç",
  "/trio kanal <ad> [şifre] — kanal modunun kanalı",
  "/trio hedef [Ad-Diyar] — fısıltının gideceği ad (boş: kendin)",
}

local function onOff(word)
  word = string.lower(word or "")
  if word == "açık" or word == "acik" or word == "aç" or word == "ac" or word == "on" then return true end
  if word == "kapalı" or word == "kapali" or word == "kapa" or word == "off" then return false end
  return nil
end

local function slash(input)
  if not db then defaults() end
  local cmd, rest = string.match(trim(input), "^(%S*)%s*(.-)$")
  cmd = string.lower(cmd or "")
  if cmd == "" or cmd == "yardım" or cmd == "yardim" or cmd == "help" then
    for _, line in ipairs(HELP) do chat(line) end
  elseif cmd == "durum" or cmd == "status" then
    printStatus()
  elseif cmd == "test" then
    ensureLogging()
    local ok, why, line = emit("test")
    if ok then chat("gönderildi: " .. tostring(line)) else chat("gönderilemedi: " .. tostring(why)) end
  elseif cmd == "mod" or cmd == "mode" then
    local mode = MODE_ALIASES[string.lower(trim(rest))] or MODE_ALIASES[trim(rest)]
    if not mode then chat("mod: fısıltı, kanal ya da kapalı") return end
    db.mode = mode
    if mode == "channel" then joinChannel() end
    chat("mod: " .. MODE_LABELS[mode])
  elseif cmd == "gizle" then
    local v = onOff(trim(rest))
    if v == nil then chat("gizle açık | kapalı") return end
    db.hide = v
    chat("gizle: " .. (v and "açık" or "kapalı"))
  elseif cmd == "kayıt" or cmd == "kayit" then
    local v = onOff(trim(rest))
    if v == nil then chat("kayıt açık | kapalı") return end
    db.autolog = v
    if v then ensureLogging() end
    chat("kendiliğinden sohbet kaydı: " .. (v and "açık" or "kapalı"))
  elseif cmd == "kanal" then
    local name, password = string.match(trim(rest), "^(%S+)%s*(%S*)$")
    if not name then chat("kanal: " .. db.channel) return end
    db.channel = name
    db.channelPassword = (password ~= "" and password) or nil
    chat("kanal: " .. name)
  elseif cmd == "hedef" then
    local target = trim(rest)
    db.target = (target ~= "" and target) or nil
    chat("fısıltı hedefi: " .. (db.target or "kendin"))
  else
    chat("bilinmeyen komut; /trio yardım")
  end
end
ns.slash = slash

-- ------------------------------------------------------------ events

local handlers = {}

function handlers.ADDON_LOADED(name)
  if name ~= ADDON_NAME then return end
  defaults()
  installFilters()
end

function handlers.PLAYER_LOGIN()
  if not db then defaults() end
  ensureLogging()
end

function handlers.PLAYER_ENTERING_WORLD()
  if not db then defaults() end
  ensureLogging()
  request("login", DEBOUNCE_SECONDS)
end

function handlers.ZONE_CHANGED_NEW_AREA() request("zone", DEBOUNCE_SECONDS) end
function handlers.ZONE_CHANGED() request("zone", DEBOUNCE_SECONDS * 2) end
function handlers.ZONE_CHANGED_INDOORS() request("zone", DEBOUNCE_SECONDS * 2) end

function handlers.PLAYER_LEVEL_UP(level)
  -- UnitLevel can still answer the old level inside this event.
  state.lastLevel = tonumber(level)
  request("level", 0)
end

function handlers.PLAYER_LOGOUT()
  if not db then return end
  -- The game writes SavedVariables right after this: the last status says
  -- "logged out". Sending a line now may or may not reach the log.
  emit("logout")
end

local EVENTS = {
  "ADDON_LOADED", "PLAYER_LOGIN", "PLAYER_ENTERING_WORLD", "ZONE_CHANGED_NEW_AREA",
  "ZONE_CHANGED", "ZONE_CHANGED_INDOORS", "PLAYER_LEVEL_UP", "PLAYER_LOGOUT",
}

local function onEvent(_, event, ...)
  local handler = handlers[event]
  if handler then
    local ok, err = pcall(handler, ...)
    if not ok then state.lastError = tostring(err) end
  end
end
ns.onEvent = onEvent

local function start()
  if type(G.CreateFrame) ~= "function" then return end
  local frame = G.CreateFrame("Frame", "TrioDurumFrame")
  for _, event in ipairs(EVENTS) do pcall(frame.RegisterEvent, frame, event) end
  frame:SetScript("OnEvent", onEvent)
  if G.C_Timer and type(G.C_Timer.NewTicker) == "function" then
    G.C_Timer.NewTicker(TICK_SECONDS, function() pcall(tick) end)
  else
    local elapsed = 0
    frame:SetScript("OnUpdate", function(_, dt)
      elapsed = elapsed + (dt or 0)
      if elapsed >= TICK_SECONDS then
        elapsed = 0
        pcall(tick)
      end
    end)
  end
  G.SLASH_TRIODURUM1 = "/trio"
  G.SLASH_TRIODURUM2 = "/triodurum"
  if type(G.SlashCmdList) == "table" then G.SlashCmdList.TRIODURUM = slash end
  ns.frame = frame
end

ns.handlers = handlers
ns.constants = {
  HEARTBEAT_SECONDS = HEARTBEAT_SECONDS, MIN_GAP_SECONDS = MIN_GAP_SECONDS,
  BUCKET_SIZE = BUCKET_SIZE, BUCKET_SECONDS = BUCKET_SECONDS, MAX_BYTES = MAX_BYTES,
}
start()
