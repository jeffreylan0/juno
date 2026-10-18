# Opens the built app on Windows the way a student does (not --hidden) and
# says what came of it: the app's log, its windows, and what changed on the
# screen, with a small picture of the screen. Then makes a selection with the
# real mouse and looks again once the bar waits (clicks then go through the
# overlay, which on Windows changes its window style). Fails if the app quit,
# never finished starting, its pages never reached it (no bar in its log), or
# it showed none of its windows. For CI (.github/workflows/desktop.yml).
param(
  [Parameter(Mandatory = $true)] [string] $Exe,
  [int] $Wait = 25,
  [string] $Picture = "$env:RUNNER_TEMP\juno-smoke.jpg"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class Smoke {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

  /// A drag with the left button, as a student makes one.
  public static void Drag(int x0, int y0, int x1, int y1) {
    SetCursorPos(x0, y0);
    System.Threading.Thread.Sleep(200);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    for (int i = 1; i <= 12; i++) {
      SetCursorPos(x0 + (x1 - x0) * i / 12, y0 + (y1 - y0) * i / 12);
      System.Threading.Thread.Sleep(30);
    }
    System.Threading.Thread.Sleep(80);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }

  public static string At(Bitmap b, int x, int y) {
    var c = b.GetPixel(x, y);
    return c.R + "," + c.G + "," + c.B;
  }

  /// The app's own windows (Tao's class) on screen.
  public static int Visible;

  /// Every process's top-level windows on screen whose title has `text`, one line each.
  public static List<string> Titled(string text) {
    var found = new List<string>();
    EnumWindows((h, l) => {
      var t = new StringBuilder(256);
      GetWindowText(h, t, 256);
      if (!IsWindowVisible(h) || t.ToString().IndexOf(text) < 0) return true;
      var c = new StringBuilder(256);
      GetClassName(h, c, 256);
      uint p;
      GetWindowThreadProcessId(h, out p);
      RECT r;
      GetWindowRect(h, out r);
      found.Add(String.Format("'{0}' [{1}] pid {2} at {3},{4} size {5}x{6}", t, c, p, r.L, r.T, r.R - r.L, r.B - r.T));
      return true;
    }, IntPtr.Zero);
    return found;
  }

  /// The process's top-level windows, one line each.
  public static List<string> Windows(int pid) {
    var found = new List<string>();
    Visible = 0;
    EnumWindows((h, l) => {
      uint p;
      GetWindowThreadProcessId(h, out p);
      if (p != (uint)pid) return true;
      var t = new StringBuilder(256);
      GetWindowText(h, t, 256);
      var c = new StringBuilder(256);
      GetClassName(h, c, 256);
      RECT r;
      GetWindowRect(h, out r);
      uint a;
      GetWindowDisplayAffinity(h, out a);
      bool v = IsWindowVisible(h);
      if (v && c.ToString() == "Tauri Window") Visible++;
      found.Add(String.Format("'{0}' [{1}] visible={2} at {3},{4} size {5}x{6} exstyle=0x{7:X} affinity={8}",
        t, c, v, r.L, r.T, r.R - r.L, r.B - r.T, GetWindowLongPtr(h, -20).ToInt64(), a));
      return true;
    }, IntPtr.Zero);
    return found;
  }

  /// Where two screenshots differ, as a grid of cells ('#' changed, '.' not), and how many pixels did.
  public static string Changes(Bitmap a, Bitmap b, int cols, int rows, out long count) {
    int w = Math.Min(a.Width, b.Width), h = Math.Min(a.Height, b.Height);
    var cells = new int[cols, rows];
    count = 0;
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++)
        if (a.GetPixel(x, y).ToArgb() != b.GetPixel(x, y).ToArgb()) {
          count++;
          cells[x * cols / w, y * rows / h]++;
        }
    var s = new StringBuilder();
    int per = (w / cols) * (h / rows);
    for (int r = 0; r < rows; r++) {
      for (int c = 0; c < cols; c++) s.Append(cells[c, r] * 20 > per ? '#' : cells[c, r] > 0 ? '+' : '.');
      s.Append('\n');
    }
    return s.ToString();
  }
}
'@

function Picture([System.Drawing.Bitmap] $shot, [string] $file, [string] $prefix) {
  $small = New-Object System.Drawing.Bitmap $shot, ([int]($shot.Width / 2)), ([int]($shot.Height / 2))
  $small.Save($file, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $text = [Convert]::ToBase64String([IO.File]::ReadAllBytes($file))
  Write-Host "-- picture $file ($($text.Length) base64 characters)"
  for ($i = 0; $i -lt $text.Length; $i += 2000) { Write-Host "$($prefix):$($text.Substring($i, [Math]::Min(2000, $text.Length - $i)))" }
  Write-Host '-- end of picture'
}

function Shot {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $g.Dispose()
  $bitmap
}

$log = Join-Path $env:LOCALAPPDATA 'com.humanbn.juno\juno.log'
Remove-Item $log -ErrorAction SilentlyContinue
# The first-run setup behind it, so opening it brings the bar up (as the
# end-to-end tests do: desktop/tests/e2e/harness.ts).
$settings = Join-Path $env:LOCALAPPDATA 'com.humanbn.juno\store\local'
New-Item -ItemType Directory -Force -Path $settings | Out-Null
Set-Content -Path (Join-Path $settings 'settings.json') -Value '{"version":6,"setupDone":true}' -Encoding ascii -NoNewline
Write-Host "Screen: $([System.Windows.Forms.Screen]::PrimaryScreen.Bounds)"
$before = $null
try { $before = Shot } catch { Write-Host "No screenshot before: $_" }

$app = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds $Wait
$app.Refresh()

$after = $null
try { $after = Shot } catch { Write-Host "No screenshot after: $_" }
$alive = -not $app.HasExited
$windows = if ($alive) { [Smoke]::Windows($app.Id) } else { @() }

Write-Host "`n== juno.log"
if (Test-Path $log) { Get-Content $log | ForEach-Object { Write-Host $_ } } else { Write-Host "(none at $log)" }
Write-Host "`n== The app"
Write-Host ($(if ($alive) { "running (pid $($app.Id))" } else { "exited with $($app.ExitCode)" }))
Write-Host "`n== Its windows"
$windows | ForEach-Object { Write-Host $_ }
Write-Host "`n== WebView2"
Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Measure-Object | ForEach-Object { Write-Host "$($_.Count) WebView2 processes" }

if ($before -and $after) {
  $count = [long]0
  $grid = [Smoke]::Changes($before, $after, 48, 24, [ref]$count)
  Write-Host "`n== The screen: $count pixels changed ('#' mostly, '+' a little)"
  Write-Host $grid
  # A small copy of the screen, in the log as base64 (between the markers).
  Picture $after $Picture 'pic'
}

# A selection: a box dragged with the real mouse, then the pointer away
# from the bar, where clicks go through the overlay to the app beneath.
if ($alive -and $after) {
  $w = $after.Width; $h = $after.Height
  Write-Host "`n== A selection"
  [Smoke]::Drag([int]($w * 0.2), [int]($h * 0.25), [int]($w * 0.45), [int]($h * 0.5))
  Start-Sleep -Seconds 5
  [void][Smoke]::SetCursorPos([int]($w * 0.15), [int]($h * 0.4))
  Start-Sleep -Seconds 2
  $app.Refresh()
  $waiting = Shot
  [Smoke]::Windows($app.Id) | ForEach-Object { Write-Host $_ }
  Write-Host '-- on screen with Juno in the title, any process'
  [Smoke]::Titled('Juno') | ForEach-Object { Write-Host $_ }
  # Where the bar sits (bottom middle), armed and then waiting: the bar's dark grey both times if it stayed on screen.
  $bx = [int]($w / 2 - 60); $by = $h - 54
  Write-Host "bar at $bx,$($by): armed $([Smoke]::At($after, $bx, $by)), waiting $([Smoke]::At($waiting, $bx, $by))"
  Write-Host '-- juno.log now'
  if (Test-Path $log) { Get-Content $log | Select-Object -Last 8 | ForEach-Object { Write-Host $_ } }
  Picture $waiting "$env:RUNNER_TEMP\juno-smoke-waiting.jpg" 'pic2'
  $alive = -not $app.HasExited
}

if ($alive) { Stop-Process -Id $app.Id -Force }

$started = (Test-Path $log) -and (Select-String -Path $log -Pattern 'setup: done' -Quiet)
if (-not $alive) { throw 'The app quit.' }
if (-not $started) { throw "The app never finished starting (juno.log has no 'setup: done')." }
# The pages' own word: a page that cannot reach the app (as when Windows'
# command URLs were sent the wrong way) never shows the bar.
if (-not (Select-String -Path $log -Pattern 'overlay: first bar' -Quiet)) { throw "The bar never came up (juno.log has no 'overlay: first bar')." }
if ([Smoke]::Visible -eq 0) { throw 'The app showed none of its windows (the bar never came up).' }
Write-Host "`nThe app started and showed $([Smoke]::Visible) of its windows."
