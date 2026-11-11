module("luci.controller.proxy_view", package.seeall)

local STATUS_PATH = "/var/run/proxy-view-guard/status.json"

function index()
  local page = entry({ "admin", "services", "proxy-view" },
    template("proxy_view/redirect"), _("多线代理控制台"), 95)
  page.dependent = false
  entry({ "admin", "services", "proxy-view", "guard" },
    template("proxy_view/guard_status"), _("渐进换线"), 10).leaf = true
  entry({ "admin", "services", "proxy-view", "guard-status" },
    call("guard_status")).leaf = true
  entry({ "admin", "services", "proxy-view", "dashboard-token" },
    call("dashboard_token")).leaf = true
  local action = entry({ "admin", "services", "proxy-view", "guard-action" },
    call("guard_action"))
  action.leaf = true
  action.post = true
end

local function reply(data, status)
  local http = require "luci.http"
  local json = require "luci.jsonc"
  if status then http.status(status) end
  http.header("Cache-Control", "no-store")
  http.prepare_content("application/json")
  http.write(json.stringify(data))
end

function dashboard_token()
  local secret = require("luci.sys").exec(
    "/usr/bin/ruby /usr/share/proxy-view/guard.rb --print-secret 2>/dev/null"
  )
  if not secret or #secret == 0 or secret:find("[\r\n]") then
    return reply({ error = "无法读取当前 OpenClash API 密钥。" }, 503)
  end
  reply({ secret = secret })
end

local function current_status()
  local fs = require "nixio.fs"
  local json = require "luci.jsonc"
  local raw = fs.readfile(STATUS_PATH)
  local data = raw and json.parse(raw) or {}
  return type(data) == "table" and data or {}
end

function guard_status()
  local uci = require("luci.model.uci").cursor()
  local data = current_status()
  local age = os.time() - (tonumber(data.updated_at) or 0)
  data.running = age >= 0 and age < 90
  data.sample_age = data.sampled_at and math.max(0, os.time() - data.sampled_at) or nil
  local global_enabled = uci:get("proxy_view_guard", "main", "enabled")
  if global_enabled then data.enabled = global_enabled == "1" end
  local numeric = {
    "idle_seconds", "check_interval", "failure_rounds", "retire_interval",
    "advice_delay_ms", "advice_ratio", "health_max_age"
  }
  for _, item in ipairs(data.exits or {}) do
    local section = "exit_" .. tostring(item.id or "")
    if uci:get("proxy_view_guard", section) then
      local enabled = uci:get("proxy_view_guard", section, "enabled")
      item.enabled = enabled == "1"
      item.settings = item.settings or {}
      item.settings.mode = uci:get("proxy_view_guard", section, "mode") or "observe"
      for _, key in ipairs(numeric) do
        local value = tonumber(uci:get("proxy_view_guard", section, key))
        if value then item.settings[key] = value end
      end
    end
  end
  reply(data)
end

local function valid_logical(value)
  return type(value) == "string" and value:match("^[A-Za-z0-9_-]+$")
    and #value <= 32
end

local function find_exit(data, logical)
  for _, item in ipairs(data.exits or {}) do
    if item.id == logical then return item end
  end
end

local function bounded(value, minimum, maximum)
  local number = tonumber(value)
  if not number or number < minimum or number > maximum
      or number ~= math.floor(number) then return nil end
  return tostring(number)
end

local function restart()
  require("luci.sys").call("/etc/init.d/proxy-view-guard restart >/dev/null 2>&1")
end

function guard_action()
  local http = require "luci.http"
  local json = require "luci.jsonc"
  local fs = require "nixio.fs"
  local uci = require("luci.model.uci").cursor()
  local payload = json.parse(http.formvalue("payload") or "") or {}
  local operation = payload.operation
  local logical = payload.logical
  local status = current_status()

  if operation == "global" then
    uci:set("proxy_view_guard", "main", "enabled", payload.enabled == true and "1" or "0")
    uci:commit("proxy_view_guard")
    restart()
    return reply({ ok = true })
  end

  if not valid_logical(logical) then return reply({ error = "无效的逻辑出口。" }, 400) end
  local exit = find_exit(status, logical)
  if not exit then return reply({ error = "该逻辑出口不在当前 Mihomo 配置中。" }, 404) end

  if operation == "save" then
    local settings = payload.settings or {}
    local ranges = {
      idle_seconds={120,86400}, check_interval={15,3600}, failure_rounds={1,20},
      retire_interval={10,3600}, advice_delay_ms={100,10000},
      advice_ratio={2,10}, health_max_age={60,3600}
    }
    local clean = {}
    for key, range in pairs(ranges) do
      clean[key] = bounded(settings[key], range[1], range[2])
      if not clean[key] then return reply({ error = key .. " 超出允许范围。" }, 400) end
    end
    local section = "exit_" .. logical
    uci:delete("proxy_view_guard", section)
    uci:section("proxy_view_guard", "exit", section, {
      logical=logical, enabled=settings.enabled == true and "1" or "0",
      mode=settings.mode == "auto" and "auto" or "observe"
    })
    for key, value in pairs(clean) do uci:set("proxy_view_guard", section, key, value) end
    uci:commit("proxy_view_guard")
    restart()
    return reply({ ok = true })
  end

  if operation == "assess" then
    fs.mkdirr("/var/run/proxy-view-guard")
    local path = "/var/run/proxy-view-guard/command-" .. tostring(os.time()) .. "-" .. tostring(math.random(100000)) .. ".yaml"
    fs.writefile(path, "action: assess\nlogical: " .. logical .. "\n")
    return reply({ ok = true })
  end

  if operation == "kick_all" then
    local util = require "luci.util"
    local command = "/usr/bin/ruby /usr/share/proxy-view/guard.rb --kick-all "
      .. util.shellquote(logical) .. " 2>/dev/null"
    local result = json.parse(require("luci.sys").exec(command) or "")
    if type(result) ~= "table" then
      return reply({ error = "无法验证关闭结果，请刷新检查；部分连接可能已关闭。" }, 409)
    end
    if not result.ok then result.error = "仍有 " .. tostring(result.remaining) .. " 条原连接未关闭。" end
    return reply(result, result.ok and 200 or 409)
  end

  if operation == "kick" then
    local connection = payload.connection
    if type(connection) ~= "string" or #connection > 128
        or not connection:match("^[A-Za-z0-9._:-]+$") then
      return reply({ error = "无效的连接 ID。" }, 400)
    end
    local util = require "luci.util"
    local command = "/usr/bin/ruby /usr/share/proxy-view/guard.rb --kick "
      .. util.shellquote(logical) .. " " .. util.shellquote(connection)
      .. " >/dev/null 2>&1"
    if require("luci.sys").call(command) ~= 0 then
      return reply({ error = "连接已变化、已经结束或不属于该逻辑出口。" }, 409)
    end
    return reply({ ok = true })
  end

  reply({ error = "未知操作。" }, 400)
end
