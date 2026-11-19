-- Test harness for TrioDurum.lua with stubbed WoW globals (plain Lua 5.1).
--   lua5.1 addon/test/harness.lua
-- Exits non-zero on the first failure.

local here = string.match(arg and arg[0] or "", "^(.*)/[^/]*$") or "."
local source = here .. "/../TrioDurum/TrioDurum.lua"

local failures, passed = 0, 0
local function check(cond, msg)
  if cond then passed = passed + 1 else failures = failures + 1; print("FAIL: " .. msg) end
end
local function eq(a, b, msg)
  check(a == b, msg .. " (got " .. tostring(a) .. ", want " .. tostring(b) .. ")")
end

-- ------------------------------------------------------------ a fake client

local function newWorld(opts)
  opts = opts or {}
  local w = {
    clock = 1800000000, sent = {}, frames = {}, logging = opts.logging or false,
    level = 36, zone = "Orgrimmar", subzone = "Valley of Strength", name = opts.name or "Kahve Kokusu",
    realm = opts.realm or "", filters = {}, chatOut = {}, lockdown = false, tickers = {},
    channels = {}, joinCalls = 0,
  }
  local env = {}
  setmetatable(env, { __index = _G })
  env.time = function() return w.clock end
  env.UnitName = function() return w.name end
  env.GetRealmName = function() return w.realm end
  env.UnitLevel = function() return w.level end
  env.UnitClass = function() return "Rogue", "ROGUE", 4 end
  env.GetRealZoneText = function() return w.zone end
  env.GetSubZoneText = function() return w.subzone end
  env.LoggingChat = function(on) if on ~= nil then w.logging = on and true or false end return w.logging end
  if not opts.noModernSend then
    env.C_ChatInfo = {
      SendChatMessage = function(msg, chatType, lang, target)
        if opts.sendFails then error("ADDON_ACTION_BLOCKED") end
        w.sent[#w.sent + 1] = { msg = msg, chatType = chatType, target = target }
      end,
      InChatMessagingLockdown = function() return w.lockdown end,
    }
  else
    env.SendChatMessage = function(msg, chatType, lang, target)
      w.sent[#w.sent + 1] = { msg = msg, chatType = chatType, target = target, legacy = true }
    end
  end
  env.GetChannelName = function(name) return w.channels[name] or 0 end
  env.JoinChannelByName = function(name) w.joinCalls = w.joinCalls + 1; w.channels[name] = 5 end
  env.ChatFrame_AddMessageEventFilter = function(event, fn) w.filters[event] = fn end
  env.DEFAULT_CHAT_FRAME = { AddMessage = function(_, text) w.chatOut[#w.chatOut + 1] = text end }
  env.SlashCmdList = {}
  env.C_Timer = { NewTicker = function(s, fn) w.tickers[#w.tickers + 1] = fn end }
  env.CreateFrame = function()
    local f = { events = {} }
    function f:RegisterEvent(e) self.events[e] = true end
    function f:SetScript(name, fn) self[name] = fn end
    w.frames[#w.frames + 1] = f
    return f
  end
  env._G = env
  env.TrioDurumDB = opts.db
  local chunk = assert(loadfile(source))
  setfenv(chunk, env)
  local ns = {}
  chunk("TrioDurum", ns)
  w.env, w.ns = env, ns
  w.fire = function(event, ...) w.frames[1].OnEvent(w.frames[1], event, ...) end
  w.tick = function() for _, fn in ipairs(w.tickers) do fn() end end
  w.advance = function(seconds) -- tick every 5 s
    local steps = math.floor(seconds / 5)
    for _ = 1, steps do w.clock = w.clock + 5; w.tick() end
  end
  return w
end

local function fields(line)
  local out = {}
  for f in string.gmatch(line .. ";", "([^;]*);") do out[#out + 1] = f end
  return out
end

local function decode(f)
  return (string.gsub(f, "%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end))
end

-- ------------------------------------------------------------ tests

do -- encoding
  local w = newWorld()
  local enc = w.ns.encodeField
  eq(enc("a;b|c%d\\e"), "a%3Bb%7Cc%25d%5Ce", "delimiters are percent-encoded")
  eq(enc("Kahve Kokusu"), "Kahve Kokusu", "spaces stay")
  eq(enc("Gölge Vadisi'nin"), "Gölge Vadisi'nin", "UTF-8 and apostrophes stay")
  eq(enc("a\nb\tc"), "a%0Ab%09c", "control bytes are encoded")
  eq(decode(enc("x;|%\\y\n")), "x;|%\\y\n", "round trip")
  eq(w.ns.utf8Cut("ağaç", 2), "a", "a cut never splits a character (ğ is 2 bytes)")
  eq(w.ns.utf8Cut("ağaç", 3), "ağ", "cut at a boundary")
end

do -- login flow: debounce, then one whisper to self with the line
  local w = newWorld()
  w.fire("ADDON_LOADED", "TrioDurum")
  check(w.filters.CHAT_MSG_WHISPER ~= nil and w.filters.CHAT_MSG_WHISPER_INFORM ~= nil, "filters installed")
  w.fire("PLAYER_LOGIN")
  eq(w.logging, true, "chat logging is turned on")
  w.fire("PLAYER_ENTERING_WORLD")
  eq(#w.sent, 0, "nothing before the debounce")
  w.advance(5)
  eq(#w.sent, 1, "one line after the debounce")
  local s = w.sent[1]
  eq(s.chatType, "WHISPER", "default transport is a whisper")
  eq(s.target, "Kahve Kokusu", "to yourself")
  local f = fields(s.msg)
  eq(f[1], "TRIO1", "frame")
  eq(f[2], "1", "seq")
  eq(f[3], tostring(w.clock), "time")
  eq(decode(f[4]), "Kahve Kokusu", "name with a space")
  eq(f[5], "", "realm may be empty")
  eq(f[6], "36", "level")
  eq(f[7], "ROGUE", "class token")
  eq(decode(f[8]), "Orgrimmar", "zone")
  eq(decode(f[9]), "Valley of Strength", "subzone")
  eq(f[10], "login", "kind")
  eq(#f, 10, "ten fields")
  check(not string.find(s.msg, "|", 1, true), "no pipe in the line")
  eq(w.env.TrioDurumDB.last.line, s.msg, "the last line is in SavedVariables")
  eq(w.env.TrioDurumDB.last.kind, "login", "saved kind")
  eq(w.env.TrioDurumDB.seq, 1, "seq saved")
end

do -- zone changes coalesce, level up uses the event's level, rate limit holds
  local w = newWorld()
  w.fire("ADDON_LOADED", "TrioDurum")
  w.fire("PLAYER_ENTERING_WORLD")
  w.advance(5)
  eq(#w.sent, 1, "login line")
  w.zone, w.subzone = "Durotar", "Razor Hill"
  w.fire("ZONE_CHANGED_NEW_AREA")
  w.fire("ZONE_CHANGED")
  w.fire("ZONE_CHANGED_INDOORS")
  w.advance(5)
  eq(#w.sent, 1, "within 10 s of the last line nothing more")
  w.advance(10)
  eq(#w.sent, 2, "the three zone events became ONE line")
  eq(fields(w.sent[2].msg)[10], "zone", "zone kind")
  eq(decode(fields(w.sent[2].msg)[8]), "Durotar", "new zone")
  w.fire("PLAYER_LEVEL_UP", 37) -- UnitLevel still says 36
  w.advance(10)
  eq(#w.sent, 3, "level line")
  eq(fields(w.sent[3].msg)[6], "37", "the event's level, not the stale UnitLevel")
  -- A flood of zone changes: at most BUCKET_SIZE automatic lines per 10 minutes.
  local before = #w.sent
  for _ = 1, 100 do
    w.fire("ZONE_CHANGED")
    w.advance(5)
  end -- 500 s
  local n = #w.sent - before
  check(n <= w.ns.constants.BUCKET_SIZE, "bucket limit (" .. n .. ")")
  check(n >= 9, "but changes still go out (" .. n .. ")")
end

do -- heartbeat
  local w = newWorld()
  w.fire("ADDON_LOADED", "TrioDurum")
  w.fire("PLAYER_ENTERING_WORLD")
  w.advance(5)
  w.advance(235)
  eq(#w.sent, 1, "no heartbeat before 240 s")
  w.advance(10)
  eq(#w.sent, 2, "heartbeat")
  eq(fields(w.sent[2].msg)[10], "beat", "beat kind")
  w.advance(240)
  eq(#w.sent, 3, "and again")
  check(tonumber(fields(w.sent[3].msg)[2]) > tonumber(fields(w.sent[2].msg)[2]), "seq increases")
end

do -- lockdown: nothing is sent, the line waits and goes out afterwards
  local w = newWorld()
  w.fire("ADDON_LOADED", "TrioDurum")
  w.lockdown = true
  w.fire("PLAYER_ENTERING_WORLD")
  w.advance(60)
  eq(#w.sent, 0, "nothing during chat lockdown")
  w.lockdown = false
  w.advance(5)
  eq(#w.sent, 1, "sent after the lockdown")
  eq(fields(w.sent[1].msg)[10], "login", "the pending kind kept")
end

do -- filter hides only our lines, and only when hide is on
  local w = newWorld()
  w.fire("ADDON_LOADED", "TrioDurum")
  local filter = w.filters.CHAT_MSG_WHISPER
  eq(filter(nil, "CHAT_MSG_WHISPER", "TRIO1;1;2;x"), true, "ours hidden")
  eq(filter(nil, "CHAT_MSG_WHISPER", "selam TRIO1;"), false, "others shown")
  eq(filter(nil, "CHAT_MSG_WHISPER", nil), false, "nil msg")
  w.ns.slash("gizle kapalı")
  eq(filter(nil, "CHAT_MSG_WHISPER", "TRIO1;1;2;x"), false, "hide off shows ours")
  w.env.issecretvalue = function() return true end
  w.ns.slash("gizle açık")
  eq(filter(nil, "CHAT_MSG_WHISPER", "TRIO1;1;2;x"), false, "a secret value is never inspected")
end

do -- slash commands: mode, test, channel, durum
  local w = newWorld()
  w.fire("ADDON_LOADED", "TrioDurum")
  w.ns.slash("test")
  eq(#w.sent, 1, "/trio test sends at once")
  eq(fields(w.sent[1].msg)[10], "test", "test kind")
  w.ns.slash("mod kanal")
  eq(w.env.TrioDurumDB.mode, "channel", "mode channel")
  w.ns.slash("test")
  eq(w.sent[2].chatType, "CHANNEL", "channel transport")
  eq(w.sent[2].target, 5, "channel number")
  w.ns.slash("mod kapalı")
  w.ns.slash("test")
  eq(#w.sent, 2, "off sends nothing")
  eq(w.env.TrioDurumDB.last.sent, false, "but the status is still saved")
  eq(w.env.TrioDurumDB.last.kind, "test", "saved kind")
  w.ns.slash("mod fisilti")
  eq(w.env.TrioDurumDB.mode, "whisper", "ascii alias")
  w.ns.slash("hedef Kahve-Forever")
  w.ns.slash("test")
  eq(w.sent[3].target, "Kahve-Forever", "whisper target override")
  local before = #w.chatOut
  w.ns.slash("durum")
  check(#w.chatOut > before, "/trio durum prints")
  check(string.find(w.chatOut[before + 1], "fısıltı", 1, true) ~= nil, "durum names the mode")
end

do -- send failures never raise; the legacy global is used when C_ChatInfo has none
  local w = newWorld({ sendFails = true })
  w.fire("ADDON_LOADED", "TrioDurum")
  w.ns.slash("test")
  check(w.ns.state.lastError ~= nil, "error recorded")
  check(w.env.TrioDurumDB.last ~= nil, "status saved anyway")
  local w2 = newWorld({ noModernSend = true })
  w2.fire("ADDON_LOADED", "TrioDurum")
  w2.ns.slash("test")
  eq(w2.sent[1] and w2.sent[1].legacy, true, "legacy SendChatMessage")
end

do -- logout writes a logout status; a long zone keeps the line under 255 bytes
  local w = newWorld()
  w.fire("ADDON_LOADED", "TrioDurum")
  w.zone = string.rep("ş;|", 60)
  w.subzone = string.rep("ğ", 80)
  w.fire("PLAYER_LOGOUT")
  local line = w.env.TrioDurumDB.last.line
  check(#line <= 255, "line within 255 bytes (" .. #line .. ")")
  eq(fields(line)[10], "logout", "logout kind last")
  eq(w.env.TrioDurumDB.last.kind, "logout", "saved logout")
end

do -- existing SavedVariables survive; seq continues
  local w = newWorld({ db = { mode = "channel", seq = 41, hide = false } })
  w.fire("ADDON_LOADED", "TrioDurum")
  eq(w.env.TrioDurumDB.mode, "channel", "mode kept")
  eq(w.env.TrioDurumDB.hide, false, "hide kept")
  w.ns.slash("test")
  eq(w.env.TrioDurumDB.seq, 42, "seq continues")
end

do -- no LoggingChat, no C_Timer, no filter API: still loads and runs
  local w = newWorld()
  w.env.LoggingChat = nil
  w.env.ChatFrame_AddMessageEventFilter = nil
  w.fire("ADDON_LOADED", "TrioDurum")
  w.fire("PLAYER_LOGIN")
  w.ns.slash("durum")
  check(string.find(w.chatOut[#w.chatOut - 1] or "", "bilinmiyor", 1, true) ~= nil
    or string.find(table.concat(w.chatOut, "\n"), "bilinmiyor", 1, true) ~= nil, "logging unknown")
end

print(string.format("%d checks passed, %d failed", passed, failures))
if failures > 0 then os.exit(1) end
