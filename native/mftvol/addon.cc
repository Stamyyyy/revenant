// Raw NTFS volume reader. Exists because Node's own fs module, on the Node
// version Electron currently bundles, misclassifies a raw volume handle
// (\\.\C:) as a directory (fstat().isDirectory() === true) and refuses
// fs.read/fs.readSync with EISDIR — confirmed on Node v20.18.3, confirmed
// NOT present on a standalone Node v24.20.0. Rather than depend on that
// version quirk, this goes straight to CreateFile/ReadFile via Win32,
// bypassing Node's fs layer (and its directory check) entirely.

#include <napi.h>
#include <windows.h>
#include <winioctl.h>
#include <map>
#include <string>

namespace {

std::map<int32_t, HANDLE> g_handles;
int32_t g_nextId = 1;

HANDLE GetHandle(const Napi::Env& env, const Napi::CallbackInfo& info, int argIndex) {
  int32_t id = info[argIndex].As<Napi::Number>().Int32Value();
  auto it = g_handles.find(id);
  if (it == g_handles.end()) {
    Napi::Error::New(env, "invalid handle").ThrowAsJavaScriptException();
    return nullptr;
  }
  return it->second;
}

// USN/journal-id values are 64-bit and not safely representable as a JS
// double past 2^53, so they cross the JS boundary as decimal strings.
uint64_t StringToU64(const std::string& s) { return std::stoull(s); }
int64_t StringToI64(const std::string& s) { return std::stoll(s); }

Napi::Value OpenVolume(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "expected path string").ThrowAsJavaScriptException();
    return env.Null();
  }
  std::u16string wpath = info[0].As<Napi::String>().Utf16Value();

  HANDLE h = CreateFileW(
    reinterpret_cast<LPCWSTR>(wpath.c_str()),
    GENERIC_READ,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    NULL,
    OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS,
    NULL
  );
  if (h == INVALID_HANDLE_VALUE) {
    Napi::Error::New(env, "CreateFile failed, code " + std::to_string(GetLastError())).ThrowAsJavaScriptException();
    return env.Null();
  }

  int32_t id = g_nextId++;
  g_handles[id] = h;
  return Napi::Number::New(env, id);
}

Napi::Value ReadVolume(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "expected (handle, offset, length)").ThrowAsJavaScriptException();
    return env.Null();
  }
  int32_t id = info[0].As<Napi::Number>().Int32Value();
  double offsetD = info[1].As<Napi::Number>().DoubleValue(); // safe: volume offsets stay well under 2^53
  uint32_t length = info[2].As<Napi::Number>().Uint32Value();

  auto it = g_handles.find(id);
  if (it == g_handles.end()) {
    Napi::Error::New(env, "invalid handle").ThrowAsJavaScriptException();
    return env.Null();
  }
  HANDLE h = it->second;

  LARGE_INTEGER li;
  li.QuadPart = static_cast<LONGLONG>(offsetD);
  if (!SetFilePointerEx(h, li, NULL, FILE_BEGIN)) {
    Napi::Error::New(env, "SetFilePointerEx failed, code " + std::to_string(GetLastError())).ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Buffer<uint8_t> buf = Napi::Buffer<uint8_t>::New(env, length);
  DWORD bytesRead = 0;
  BOOL ok = ReadFile(h, buf.Data(), length, &bytesRead, NULL);
  if (!ok) {
    Napi::Error::New(env, "ReadFile failed, code " + std::to_string(GetLastError())).ThrowAsJavaScriptException();
    return env.Null();
  }
  if (bytesRead != length) {
    Napi::Error::New(env, "short read: " + std::to_string(bytesRead) + "/" + std::to_string(length)).ThrowAsJavaScriptException();
    return env.Null();
  }
  return buf;
}

Napi::Value CloseVolume(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t id = info[0].As<Napi::Number>().Int32Value();
  auto it = g_handles.find(id);
  if (it != g_handles.end()) {
    CloseHandle(it->second);
    g_handles.erase(it);
  }
  return env.Undefined();
}

// Returns {journalId, nextUsn, maxUsn} (all as decimal strings — see
// StringToU64/I64). Throws if no journal exists yet; call CreateUsnJournal
// first in that case (ERROR_JOURNAL_NOT_ACTIVE = 1179).
Napi::Value QueryUsnJournal(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = GetHandle(env, info, 0);
  if (!h) return env.Null();

  USN_JOURNAL_DATA_V0 data;
  DWORD bytesReturned;
  BOOL ok = DeviceIoControl(h, FSCTL_QUERY_USN_JOURNAL, NULL, 0, &data, sizeof(data), &bytesReturned, NULL);
  if (!ok) {
    Napi::Error::New(env, "FSCTL_QUERY_USN_JOURNAL failed, code " + std::to_string(GetLastError())).ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Object result = Napi::Object::New(env);
  result.Set("journalId", Napi::String::New(env, std::to_string(data.UsnJournalID)));
  result.Set("nextUsn", Napi::String::New(env, std::to_string(data.NextUsn)));
  result.Set("maxUsn", Napi::String::New(env, std::to_string(data.MaxUsn)));
  return result;
}

// Creates (or, if one already exists, no-ops on) the volume's USN journal.
// Requires elevation, which this app already requires for volume reads.
Napi::Value CreateUsnJournal(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = GetHandle(env, info, 0);
  if (!h) return env.Null();

  CREATE_USN_JOURNAL_DATA cjd;
  cjd.MaximumSize = 32ULL * 1024 * 1024;   // 32MB — same order of magnitude as Windows' own default
  cjd.AllocationDelta = 4ULL * 1024 * 1024;
  DWORD bytesReturned;
  BOOL ok = DeviceIoControl(h, FSCTL_CREATE_USN_JOURNAL, &cjd, sizeof(cjd), NULL, 0, &bytesReturned, NULL);
  if (!ok) {
    Napi::Error::New(env, "FSCTL_CREATE_USN_JOURNAL failed, code " + std::to_string(GetLastError())).ThrowAsJavaScriptException();
    return env.Null();
  }
  return env.Undefined();
}

// Non-blocking (Timeout=0): returns immediately with whatever's already in
// the journal at/after startUsn, even if that's zero records. Polled from a
// JS interval rather than done as a real blocking wait, so this never stalls
// the Electron main thread. Returns a raw Buffer — first 8 bytes are the
// next-call start USN (int64 LE), followed by back-to-back USN_RECORD_V2
// entries; parsing happens in JS, same pattern as MFT record parsing.
Napi::Value ReadUsnJournal(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 5) {
    Napi::TypeError::New(env, "expected (handle, journalId, startUsn, reasonMask, bufferSize)").ThrowAsJavaScriptException();
    return env.Null();
  }
  HANDLE h = GetHandle(env, info, 0);
  if (!h) return env.Null();
  uint64_t journalId = StringToU64(info[1].As<Napi::String>().Utf8Value());
  int64_t startUsn = StringToI64(info[2].As<Napi::String>().Utf8Value());
  uint32_t reasonMask = info[3].As<Napi::Number>().Uint32Value();
  uint32_t bufferSize = info[4].As<Napi::Number>().Uint32Value();

  READ_USN_JOURNAL_DATA_V0 rjd;
  rjd.StartUsn = startUsn;
  rjd.ReasonMask = reasonMask;
  rjd.ReturnOnlyOnClose = 0;
  rjd.Timeout = 0;
  rjd.BytesToWaitFor = 0;
  rjd.UsnJournalID = journalId;

  Napi::Buffer<uint8_t> buf = Napi::Buffer<uint8_t>::New(env, bufferSize);
  DWORD bytesReturned = 0;
  BOOL ok = DeviceIoControl(h, FSCTL_READ_USN_JOURNAL, &rjd, sizeof(rjd), buf.Data(), bufferSize, &bytesReturned, NULL);
  if (!ok) {
    Napi::Error::New(env, "FSCTL_READ_USN_JOURNAL failed, code " + std::to_string(GetLastError())).ThrowAsJavaScriptException();
    return env.Null();
  }
  // bytesReturned may be less than bufferSize (that's normal — it's how much
  // was actually filled); hand back a properly-sized view rather than the
  // full over-allocated buffer.
  return Napi::Buffer<uint8_t>::Copy(env, buf.Data(), bytesReturned);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("openVolume", Napi::Function::New(env, OpenVolume));
  exports.Set("readVolume", Napi::Function::New(env, ReadVolume));
  exports.Set("closeVolume", Napi::Function::New(env, CloseVolume));
  exports.Set("queryUsnJournal", Napi::Function::New(env, QueryUsnJournal));
  exports.Set("createUsnJournal", Napi::Function::New(env, CreateUsnJournal));
  exports.Set("readUsnJournal", Napi::Function::New(env, ReadUsnJournal));
  return exports;
}

} // namespace

NODE_API_MODULE(mftvol, Init)
