module("luci.controller.proxy_view", package.seeall)

function index()
  local page = entry(
    { "admin", "services", "proxy-view" },
    template("proxy_view/redirect"),
    _("多线代理控制台"),
    95
  )
  page.dependent = false
end
