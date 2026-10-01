# dsh-notify — Windows 系统通知（Toast）发送器
#
# 由 lib/index.js 通过 spawn 调用；每次通知一个短命进程，stdout/stderr 均被忽略。
# 使用 DeepSeek Harness 已注册的 AppUserModelID（com.deepseek.dsh），
# 因此通知会带着 DSH 的名字和图标出现在操作中心 —— 未经注册的 AUMID
# 会被 Windows 静默丢弃，这一点已实测确认。
#
# 退出码：0 表示已交给系统；1 表示失败（原因写入 stderr）。

param(
  [Parameter(Mandatory = $true)][string]$AppId,
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Body = "",
  [ValidateSet("short", "long")][string]$Duration = "short",
  [switch]$Silent
)

$ErrorActionPreference = "Stop"

try {
  # 加载 WinRT 投影类型。必须先于任何 Windows.UI.* 的使用。
  # 注意：`ContentType=WindowsRuntime` 不能写成 `ContentType = WindowsRuntime` ——
  # 加上空格后类型解析会静默失败，随后 New-Object 报 "Cannot find type"。
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
  [void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]

  # 标题/正文来自工具名、审批理由、错误信息等任意外部文本，
  # 必须转义后才能拼进 XML，否则一个 & 或 < 就会让 LoadXml 抛错。
  $safeTitle = [System.Security.SecurityElement]::Escape($Title)
  $safeBody = [System.Security.SecurityElement]::Escape($Body)

  $bodyElement = if ([string]::IsNullOrWhiteSpace($safeBody)) { "" } else { "<text>$safeBody</text>" }
  $audioElement = if ($Silent) { '<audio silent="true"/>' } else { "" }

  $xmlText = @"
<toast duration="$Duration">
  <visual>
    <binding template="ToastGeneric">
      <text>$safeTitle</text>
      $bodyElement
    </binding>
  </visual>
  $audioElement
</toast>
"@

  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($xmlText)

  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId)
  $notifier.Show($toast)

  exit 0
}
catch {
  [Console]::Error.WriteLine("dsh-notify toast failed: " + $_.Exception.Message)
  exit 1
}