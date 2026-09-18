using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Local executable shim for the desktop's existing CODEX_CLI_PATH override.
// No installed binary, app integrity setting, approval or sandbox policy is changed.
internal static class CliBridge {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
        public long processTime, jobTime; public uint flags; public UIntPtr minimumWorkingSet, maximumWorkingSet;
        public uint activeProcessLimit; public UIntPtr affinity; public uint priorityClass, schedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
        public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    static string Quote(string value) {
        var result = new StringBuilder("\""); int backslashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { backslashes++; continue; }
            if (ch == '"') result.Append('\\', backslashes * 2 + 1);
            else result.Append('\\', backslashes);
            backslashes = 0; result.Append(ch);
        }
        result.Append('\\', backslashes * 2); result.Append('"'); return result.ToString();
    }
    static Thread Copy(Stream source, Stream destination, bool closeDestination) {
        var thread = new Thread(delegate() {
            try {
                var bytes = new byte[32768]; int count;
                while ((count = source.Read(bytes, 0, bytes.Length)) > 0) {
                    destination.Write(bytes, 0, count); destination.Flush();
                }
            } catch (IOException) { } catch (ObjectDisposedException) { }
            finally { if (closeDestination) try { destination.Close(); } catch { } }
        });
        thread.IsBackground = true; thread.Start(); return thread;
    }
    static int Main(string[] args) {
        IntPtr job = IntPtr.Zero;
        try {
            string directory = AppDomain.CurrentDomain.BaseDirectory;
            var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(directory, "runtime-config.json")));
            string node = (string)config["nodeExecutable"];
            string script = Path.Combine(directory, "proxy.mjs");
            var arguments = new StringBuilder(Quote(script));
            foreach (string argument in args) arguments.Append(' ').Append(Quote(argument));
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new InvalidOperationException("Cannot create bridge process job");
            var limits = new EXTENDED_LIMIT(); limits.basic.flags = 0x00002000; // KILL_ON_JOB_CLOSE
            int size = Marshal.SizeOf(limits); IntPtr info = Marshal.AllocHGlobal(size);
            try {
                Marshal.StructureToPtr(limits, info, false);
                if (!SetInformationJobObject(job, 9, info, (uint)size)) throw new InvalidOperationException("Cannot set bridge job lifetime");
            } finally { Marshal.FreeHGlobal(info); }
            var start = new ProcessStartInfo(node, arguments.ToString());
            start.UseShellExecute = false; start.CreateNoWindow = true;
            start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
            using (var child = Process.Start(start)) {
                if (!AssignProcessToJobObject(job, child.Handle)) { child.Kill(); throw new InvalidOperationException("Cannot attach bridge process job"); }
                Copy(Console.OpenStandardInput(), child.StandardInput.BaseStream, true);
                var stdout = Copy(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), false);
                var stderr = Copy(child.StandardError.BaseStream, Console.OpenStandardError(), false);
                child.WaitForExit(); stdout.Join(); stderr.Join(); return child.ExitCode;
            }
        } catch (Exception error) { Console.Error.WriteLine("ThreadBrief bridge failed: " + error.Message); return 70; }
        finally { if (job != IntPtr.Zero) CloseHandle(job); }
    }
}
