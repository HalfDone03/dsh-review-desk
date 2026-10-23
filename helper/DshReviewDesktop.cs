using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class DshReviewDesktop
{
    private const uint DESKTOP_ALL_ACCESS = 0x10000000;
    private const uint DESKTOP_READOBJECTS = 0x0001;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint CREATE_ALWAYS = 2;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x80;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint WAIT_TIMEOUT = 0x00000102;
    private const int STD_INPUT_HANDLE = -10;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);
    private const int UOI_NAME = 2;

    private static readonly string DefaultStatePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "dsh-review-desk",
        "state.txt");

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            try { Console.OutputEncoding = Encoding.UTF8; } catch { }
            if (args.Length == 0)
            {
                Console.Error.WriteLine("usage: DshReviewDesktop.exe <ensure|open|return|close|status|run|panel|watchdog> [options]");
                return 2;
            }

            string role = args[0].ToLowerInvariant();
            Log("main role=" + role + " argc=" + args.Length);
            Dictionary<string, string> a = ParseArgs(args, 1);

            switch (role)
            {
                case "ensure": return Ensure(a);
                case "open": return Open(a);
                case "return": return ReturnHome(a);
                case "close": return Close(a);
                case "status": return Status(a);
                case "run": return Run(a);
                case "panel": return Panel(a);
                case "watchdog": return Watchdog(a);
                default:
                    Console.Error.WriteLine("unknown role: " + role);
                    return 2;
            }
        }
        catch (Exception ex)
        {
            Log("FATAL " + ex);
            Console.Error.WriteLine("FATAL " + ex.GetType().Name + ": " + ex.Message);
            return 3;
        }
    }

    private static int Ensure(Dictionary<string, string> a)
    {
        string desktop = Get(a, "--desktop", "DSH-Review-Desk");
        string url = Get(a, "--url", "");
        string statePath = Path.GetFullPath(Get(a, "--state", DefaultStatePath));
        string profile = Path.GetFullPath(Get(a, "--profile", Path.Combine(Path.GetDirectoryName(statePath), "edge-profile")));

        if (url.Length == 0)
        {
            Console.Error.WriteLine("missing --url");
            return 4;
        }

        IntPtr desk = OpenOrCreateDesktop(desktop);
        if (desk == IntPtr.Zero)
        {
            Console.Error.WriteLine("desktop unavailable: " + desktop + " err=" + Marshal.GetLastWin32Error());
            return 5;
        }

        Dictionary<string, string> state = ReadState(statePath);
        string oldDesktop = Get(state, "desktop", "");
        if (oldDesktop.Length > 0 && !string.Equals(oldDesktop, desktop, StringComparison.OrdinalIgnoreCase))
        {
            // A different desk is still tracked. Close it first so we do not leave orphans.
            state["desktop"] = oldDesktop;
            CloseState(state, statePath);
            state = new Dictionary<string, string>();
        }

        Directory.CreateDirectory(Path.GetDirectoryName(statePath));
        Directory.CreateDirectory(profile);

        int browserPid = AlivePid(state, "browserPid");
        List<int> profileEdges = FindProfileEdgePids(profile);
        if (browserPid <= 0 && profileEdges.Count > 0) browserPid = profileEdges[0];
        if (browserPid <= 0)
        {
            string edge = Get(a, "--edge", FindEdge());
            if (!File.Exists(edge))
            {
                Console.Error.WriteLine("edge not found: " + edge);
                CloseDesktop(desk);
                return 6;
            }

            string edgeArgs =
                "--app=\"" + url + "\" " +
                "--user-data-dir=\"" + profile + "\" " +
                "--no-first-run --no-default-browser-check --disable-sync --disable-extensions " +
                "--disable-background-mode --window-size=1100,800";
            int pid;
            if (!LaunchOnDesktop(edge, edgeArgs, desktop, false, out pid))
            {
                Console.Error.WriteLine("edge launch failed err=" + Marshal.GetLastWin32Error());
                CloseDesktop(desk);
                return 7;
            }
            browserPid = pid;
        }

        int panelPid = AlivePid(state, "panelPid");
        if (panelPid <= 0)
        {
            string self = Assembly.GetExecutingAssembly().Location;
            string panelArgs = "panel --desktop \"" + desktop + "\" --seconds " + Get(a, "--panelSeconds", "0");
            int pid;
            if (!LaunchOnDesktop(self, panelArgs, desktop, true, out pid))
            {
                Console.Error.WriteLine("panel launch failed err=" + Marshal.GetLastWin32Error());
                KillPid(browserPid);
                CloseDesktop(desk);
                return 8;
            }
            panelPid = pid;
            Log("panel launched pid=" + pid);
            Thread.Sleep(900);
            try
            {
                Process pp = Process.GetProcessById(pid);
                string exit = "alive";
                if (pp.HasExited) exit = "exited:" + pp.ExitCode;
                Log("panel state " + exit);
            }
            catch (Exception ex)
            {
                Log("panel gone " + ex.Message);
            }
        }

        Log("ensure writing state");
        state["desktop"] = desktop;
        state["url"] = url;
        state["profile"] = profile;
        state["browserPid"] = browserPid.ToString();
        state["panelPid"] = panelPid.ToString();
        WriteState(statePath, state);
        Log("ensure closing desktop");
        CloseDesktop(desk);
        Log("ensure done");

        Console.WriteLine("OK ensure desktop=" + desktop + " browserPid=" + browserPid + " panelPid=" + panelPid);
        return 0;
    }

    private static int Open(Dictionary<string, string> a)
    {
        int rc = Ensure(a);
        if (rc != 0) return rc;

        string statePath = Get(a, "--state", DefaultStatePath);
        Dictionary<string, string> state = ReadState(statePath);
        string desktop = Get(state, "desktop", Get(a, "--desktop", "DSH-Review-Desk"));
        state["foreground"] = GetForegroundWindow().ToInt64().ToString();
        WriteState(statePath, state);

        IntPtr desk = OpenDesktopW(desktop, 0, false, DESKTOP_ALL_ACCESS);
        if (desk == IntPtr.Zero)
        {
            Console.Error.WriteLine("open desktop failed err=" + Marshal.GetLastWin32Error());
            return 9;
        }

        bool ok = SwitchDesktop(desk);
        CloseDesktop(desk);
        Console.WriteLine("OK open desktop=" + desktop + " switched=" + ok + " err=" + (ok ? 0 : Marshal.GetLastWin32Error()));
        return ok ? 0 : 10;
    }

    private static int ReturnHome(Dictionary<string, string> a)
    {
        string statePath = Get(a, "--state", DefaultStatePath);
        Dictionary<string, string> state = ReadState(statePath);

        IntPtr desk = OpenDesktopW("Default", 0, false, DESKTOP_ALL_ACCESS);
        if (desk == IntPtr.Zero)
        {
            Console.Error.WriteLine("open default failed err=" + Marshal.GetLastWin32Error());
            return 11;
        }

        bool ok = SwitchDesktop(desk);
        CloseDesktop(desk);
        Thread.Sleep(200);

        bool focus = false;
        string fg = Get(state, "foreground", "0");
        long hwndValue;
        if (long.TryParse(fg, out hwndValue) && hwndValue != 0)
        {
            focus = SetForegroundWindow(new IntPtr(hwndValue));
        }

        Console.WriteLine("OK return switched=" + ok + " focus=" + focus + " err=" + (ok ? 0 : Marshal.GetLastWin32Error()));
        return ok ? 0 : 12;
    }

    private static int Close(Dictionary<string, string> a)
    {
        string statePath = Get(a, "--state", DefaultStatePath);
        CloseState(ReadState(statePath), statePath);
        Console.WriteLine("OK close");
        return 0;
    }

    private static int Status(Dictionary<string, string> a)
    {
        string statePath = Get(a, "--state", DefaultStatePath);
        Dictionary<string, string> state = ReadState(statePath);
        string profile = FullPathOrEmpty(Get(state, "profile", ""));
        int browserPid = AlivePid(state, "browserPid");
        List<int> edges = FindProfileEdgePids(profile);
        if (browserPid <= 0 && edges.Count > 0) browserPid = edges[0];
        int panelPid = AlivePid(state, "panelPid");
        Console.WriteLine("active=" + ActiveDesktopName());
        Console.WriteLine("desktop=" + Get(state, "desktop", ""));
        Console.WriteLine("browserPid=" + browserPid);
        Console.WriteLine("browserCount=" + edges.Count);
        Console.WriteLine("panelPid=" + panelPid);
        Console.WriteLine("profile=" + profile);
        return 0;
    }

    private static int Panel(Dictionary<string, string> a)
    {
        string desktop = Get(a, "--desktop", "DSH-Review-Desk");
        int seconds = GetInt(a, "--seconds", 0);

        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        Form form = new Form();
        form.Text = "DSH 复验桌面";
        form.FormBorderStyle = FormBorderStyle.None;
        form.StartPosition = FormStartPosition.Manual;
        form.ShowInTaskbar = false;
        form.TopMost = true;
        form.BackColor = Color.FromArgb(28, 30, 34);
        form.ForeColor = Color.White;
        form.Width = 430;
        form.Height = 122;
        form.Padding = new Padding(16);
        form.FormClosing += delegate(object sender, FormClosingEventArgs e) { Log("panel closing reason=" + e.CloseReason); };

        Rectangle wa = Screen.PrimaryScreen.WorkingArea;
        form.Location = new Point(wa.Right - form.Width - 24, wa.Bottom - form.Height - 24);

        Label title = new Label();
        title.Text = "复验桌面";
        title.Font = new Font("Microsoft YaHei UI", 11f, FontStyle.Bold);
        title.ForeColor = Color.White;
        title.AutoSize = true;
        title.Location = new Point(18, 14);
        form.Controls.Add(title);

        Label hint = new Label();
        hint.Text = "看完后点“返回工作桌面”，或按 Ctrl+Alt+Shift+F12。";
        hint.Font = new Font("Microsoft YaHei UI", 9f);
        hint.ForeColor = Color.FromArgb(190, 196, 205);
        hint.AutoSize = true;
        hint.Location = new Point(18, 44);
        form.Controls.Add(hint);

        Button back = new Button();
        back.Text = "返回工作桌面";
        back.Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold);
        back.FlatStyle = FlatStyle.Flat;
        back.FlatAppearance.BorderSize = 0;
        back.BackColor = Color.FromArgb(64, 132, 255);
        back.ForeColor = Color.White;
        back.Width = 132;
        back.Height = 34;
        back.Location = new Point(18, 76);
        back.Click += delegate { ReturnFromPanel(form); };
        form.Controls.Add(back);

        Button quit = new Button();
        quit.Text = "关闭复验桌面";
        quit.Font = new Font("Microsoft YaHei UI", 9f);
        quit.FlatStyle = FlatStyle.Flat;
        quit.FlatAppearance.BorderColor = Color.FromArgb(90, 96, 106);
        quit.BackColor = Color.FromArgb(40, 43, 49);
        quit.ForeColor = Color.White;
        quit.Width = 132;
        quit.Height = 34;
        quit.Location = new Point(160, 76);
        quit.Click += delegate { ReturnFromPanel(form); };
        form.Controls.Add(quit);

        if (seconds > 0)
        {
            System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
            timer.Interval = Math.Max(1, seconds) * 1000;
            timer.Tick += delegate
            {
                timer.Stop();
                ReturnFromPanel(form);
            };
            timer.Start();
        }

        Log("panel run start desktop=" + desktop + " seconds=" + seconds);
        try
        {
            Application.Run(form);
            Log("panel run done");
            return 0;
        }
        catch (Exception ex)
        {
            Log("panel run error " + ex);
            return 15;
        }
    }

    private static void ReturnFromPanel(Form form)
    {
        Log("return from panel requested");
        IntPtr desk = OpenDesktopW("Default", 0, false, DESKTOP_ALL_ACCESS);
        if (desk != IntPtr.Zero)
        {
            SwitchDesktop(desk);
            CloseDesktop(desk);
        }
        form.Close();
        Application.Exit();
    }

    private static int Watchdog(Dictionary<string, string> a)
    {
        int seconds = GetInt(a, "--seconds", 10);
        Thread.Sleep(Math.Max(1, seconds) * 1000);

        IntPtr desk = OpenDesktopW("Default", 0, false, DESKTOP_ALL_ACCESS);
        if (desk == IntPtr.Zero)
        {
            Console.Error.WriteLine("watchdog open default failed err=" + Marshal.GetLastWin32Error());
            return 13;
        }

        bool ok = SwitchDesktop(desk);
        CloseDesktop(desk);
        Console.WriteLine("OK watchdog switched=" + ok);
        return ok ? 0 : 14;
    }

    private static void CloseState(Dictionary<string, string> state, string statePath)
    {
        // Never leave the user on the private desktop if they are still there.
        IntPtr defaultDesk = OpenDesktopW("Default", 0, false, DESKTOP_ALL_ACCESS);
        if (defaultDesk != IntPtr.Zero)
        {
            SwitchDesktop(defaultDesk);
            CloseDesktop(defaultDesk);
            Thread.Sleep(150);
        }

        int panelPid = AlivePid(state, "panelPid");
        int browserPid = AlivePid(state, "browserPid");
        if (panelPid > 0) KillPid(panelPid);
        if (browserPid > 0) KillPid(browserPid);

        string trackedProfile = FullPathOrEmpty(Get(state, "profile", ""));
        foreach (int pid in FindProfileEdgePids(trackedProfile)) KillPid(pid);
        Thread.Sleep(900);

        string desktop = Get(state, "desktop", "");
        if (desktop.Length > 0)
        {
            IntPtr desk = OpenDesktopW(desktop, 0, false, DESKTOP_ALL_ACCESS);
            if (desk != IntPtr.Zero) CloseDesktop(desk);
        }

        string profile = trackedProfile;
        if (profile.Length > 0)
        {
            foreach (int pid in FindProfileEdgePids(profile)) KillPid(pid);
            Thread.Sleep(700);
            for (int i = 0; i < 3; i++)
            {
                try
                {
                    if (Directory.Exists(profile)) Directory.Delete(profile, true);
                    break;
                }
                catch
                {
                    Thread.Sleep(700);
                }
            }
        }

        try { if (File.Exists(statePath)) File.Delete(statePath); } catch { }
    }

    private static IntPtr OpenOrCreateDesktop(string name)
    {
        IntPtr desk = OpenDesktopW(name, 0, false, DESKTOP_ALL_ACCESS);
        if (desk != IntPtr.Zero) return desk;

        int err = Marshal.GetLastWin32Error();
        if (err == 2 || err == 0)
        {
            return CreateDesktopW(name, IntPtr.Zero, IntPtr.Zero, 0, DESKTOP_ALL_ACCESS, IntPtr.Zero);
        }
        return IntPtr.Zero;
    }

    private static int Run(Dictionary<string, string> a)
    {
        string desktop = Get(a, "--desktop", "DSH-Review-Desk");
        string script = Get(a, "--script", "");
        string log = Get(a, "--log", "");
        string cwd = Get(a, "--cwd", "");
        int timeout = GetInt(a, "--timeout", 120000);
        if (script.Length == 0 || log.Length == 0)
        {
            Console.Error.WriteLine("run requires --script and --log");
            return 4;
        }

        string fullScript = Path.GetFullPath(script);
        string fullLog = Path.GetFullPath(log);
        if (!File.Exists(fullScript))
        {
            Console.Error.WriteLine("script not found: " + fullScript);
            return 4;
        }
        Directory.CreateDirectory(Path.GetDirectoryName(fullLog));
        Directory.CreateDirectory(Path.GetDirectoryName(fullScript));

        IntPtr desk = OpenOrCreateDesktop(desktop);
        if (desk == IntPtr.Zero)
        {
            Console.Error.WriteLine("desktop unavailable: " + desktop + " err=" + Marshal.GetLastWin32Error());
            return 4;
        }
        CloseDesktop(desk);

        string powershell = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            @"WindowsPowerShell\v1.0\powershell.exe");
        if (!File.Exists(powershell)) powershell = "powershell.exe";

        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
        sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        sa.bInheritHandle = true;
        IntPtr hLog = CreateFileW(
            fullLog,
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ref sa,
            CREATE_ALWAYS,
            FILE_ATTRIBUTE_NORMAL,
            IntPtr.Zero);
        if (hLog == INVALID_HANDLE_VALUE)
        {
            Console.Error.WriteLine("cannot open log: " + fullLog + " err=" + Marshal.GetLastWin32Error());
            return 4;
        }

        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.lpDesktop = @"WinSta0\" + desktop;
        si.dwFlags = (int)STARTF_USESTDHANDLES;
        si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        si.hStdOutput = hLog;
        si.hStdError = hLog;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        string commandLine = "\"" + powershell + "\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + fullScript + "\"";
        string currentDirectory = cwd.Length > 0 ? Path.GetFullPath(cwd) : null;

        bool ok = CreateProcessW(
            powershell,
            commandLine,
            IntPtr.Zero,
            IntPtr.Zero,
            true,
            CREATE_NO_WINDOW,
            IntPtr.Zero,
            currentDirectory,
            ref si,
            out pi);
        int createError = ok ? 0 : Marshal.GetLastWin32Error();
        CloseHandle(hLog);
        Log("run CreateProcess desktop=" + desktop + " ok=" + ok + " err=" + createError);
        if (!ok)
        {
            Console.Error.WriteLine("CreateProcess failed err=" + createError);
            return 5;
        }

        uint wait = WaitForSingleObject(pi.hProcess, (uint)Math.Max(1000, timeout));
        bool timedOut = wait == WAIT_TIMEOUT;
        int pid = Convert.ToInt32(pi.dwProcessId);
        if (timedOut)
        {
            // TerminateProcess 只结束 powershell 本身；任务可能已经派生了
            // GUI/子进程，必须按进程树收掉，否则它会留在私有桌面上。
            // 先按进程树杀，再 TerminateProcess；否则父进程先退出后
            // taskkill /T 可能找不到树，留下 GUI 子进程。
            KillPid(pid);
            TerminateProcess(pi.hProcess, 124);
            WaitForSingleObject(pi.hProcess, 5000);
        }
        uint exitCode = 0;
        GetExitCodeProcess(pi.hProcess, out exitCode);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);

        Console.WriteLine(
            "OK run pid=" + pid +
            " exit=" + exitCode +
            " timeout=" + (timedOut ? 1 : 0) +
            " log=" + fullLog);
        return timedOut ? 124 : (int)exitCode;
    }

    private static bool LaunchOnDesktop(string exe, string args, string desktop, bool noWindow, out int pid)
    {
        pid = 0;
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.lpDesktop = @"WinSta0\" + desktop;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();

        string commandLine = "\"" + exe + "\" " + args;
        uint flags = noWindow ? CREATE_NO_WINDOW : 0;
        bool ok = CreateProcessW(exe, commandLine, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, null, ref si, out pi);
        Log("CreateProcess exe=" + exe + " desktop=" + desktop + " ok=" + ok + " err=" + (ok ? 0 : Marshal.GetLastWin32Error()));
        if (!ok) return false;

        pid = Convert.ToInt32(pi.dwProcessId);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return true;
    }

    private static void KillPid(int pid)
    {
        if (pid <= 0) return;
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("taskkill.exe", "/PID " + pid + " /T /F");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            Process p = Process.Start(psi);
            if (p != null) p.WaitForExit(5000);
        }
        catch { }
    }

    private static int AlivePid(Dictionary<string, string> state, string key)
    {
        int pid;
        if (!int.TryParse(Get(state, key, "0"), out pid) || pid <= 0) return 0;
        try
        {
            Process p = Process.GetProcessById(pid);
            return p.HasExited ? 0 : pid;
        }
        catch { return 0; }
    }

    private static List<int> FindProfileEdgePids(string profile)
    {
        List<int> pids = new List<int>();
        if (string.IsNullOrWhiteSpace(profile)) return pids;
        try { profile = Path.GetFullPath(profile); } catch { }
        try
        {
            using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'msedge.exe'"))
            using (ManagementObjectCollection rows = searcher.Get())
            {
                foreach (ManagementObject row in rows)
                {
                    try
                    {
                        string commandLine = Convert.ToString(row["CommandLine"]);
                        if (commandLine.IndexOf(profile, StringComparison.OrdinalIgnoreCase) < 0) continue;
                        pids.Add(Convert.ToInt32(row["ProcessId"]));
                    }
                    catch { }
                    finally
                    {
                        row.Dispose();
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Log("FindProfileEdgePids failed: " + ex.Message);
        }
        return pids;
    }

    private static string FindEdge()
    {
        string[] candidates =
        {
            @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Edge\Application\msedge.exe")
        };
        foreach (string path in candidates) if (File.Exists(path)) return path;
        return candidates[0];
    }

    private static void Log(string message)
    {
        try
        {
            File.AppendAllText(
                Path.Combine(Path.GetTempPath(), "dsh-review-desktop.log"),
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + message + Environment.NewLine,
                Encoding.UTF8);
        }
        catch { }
    }

    private static string FullPathOrEmpty(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return "";
        try { return Path.GetFullPath(path); } catch { return path; }
    }

    private static string ActiveDesktopName()
    {
        IntPtr h = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
        if (h == IntPtr.Zero) return "ERROR:" + Marshal.GetLastWin32Error();
        try
        {
            StringBuilder sb = new StringBuilder(256);
            int needed;
            bool ok = GetUserObjectInformationW(h, UOI_NAME, sb, sb.Capacity * 2, out needed);
            return ok ? sb.ToString() : "ERROR:" + Marshal.GetLastWin32Error();
        }
        finally
        {
            CloseDesktop(h);
        }
    }

    private static Dictionary<string, string> ParseArgs(string[] args, int start)
    {
        Dictionary<string, string> d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = start; i < args.Length; i++)
        {
            if (args[i].StartsWith("--", StringComparison.Ordinal) && i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
            {
                d[args[i]] = args[i + 1];
                i++;
            }
        }
        return d;
    }

    private static string Get(Dictionary<string, string> d, string key, string fallback)
    {
        string v;
        return d.TryGetValue(key, out v) ? v : fallback;
    }

    private static int GetInt(Dictionary<string, string> d, string key, int fallback)
    {
        int v;
        return int.TryParse(Get(d, key, ""), out v) ? v : fallback;
    }

    private static Dictionary<string, string> ReadState(string path)
    {
        Dictionary<string, string> d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            if (!File.Exists(path)) return d;
            foreach (string line in File.ReadAllLines(path, Encoding.UTF8))
            {
                int eq = line.IndexOf('=');
                if (eq > 0) d[line.Substring(0, eq)] = line.Substring(eq + 1);
            }
        }
        catch { }
        return d;
    }

    private static void WriteState(string path, Dictionary<string, string> state)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        List<string> lines = new List<string>();
        foreach (KeyValuePair<string, string> pair in state) lines.Add(pair.Key + "=" + pair.Value);
        File.WriteAllLines(path, lines, Encoding.UTF8);
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateDesktopW(string lpszDesktop, IntPtr lpszDevice, IntPtr pDevmode, int dwFlags, uint dwDesiredAccess, IntPtr lpsa);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr OpenDesktopW(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SwitchDesktop(IntPtr hDesktop);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool GetUserObjectInformationW(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(
        string lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFileW(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        ref SECURITY_ATTRIBUTES lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int nStdHandle);
}
