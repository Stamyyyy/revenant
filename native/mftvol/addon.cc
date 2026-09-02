// Raw NTFS volume reader. Exists because Node's own fs module, on the Node
// version Electron currently bundles, misclassifies a raw volume handle
// (\\.\C:) as a directory (fstat().isDirectory() === true) and refuses
// fs.read/fs.readSync with EISDIR — confirmed on Node v20.18.3, confirmed
// NOT present on a standalone Node v24.20.0. Rather than depend on that
// version quirk, this goes straight to CreateFile/ReadFile via Win32,
// bypassing Node's fs layer (and its directory check) entirely.

#include <napi.h>
#include <windows.h>
#include <map>
#include <string>

namespace {

std::map<int32_t, HANDLE> g_handles;
int32_t g_nextId = 1;

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

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("openVolume", Napi::Function::New(env, OpenVolume));
  exports.Set("readVolume", Napi::Function::New(env, ReadVolume));
  exports.Set("closeVolume", Napi::Function::New(env, CloseVolume));
  return exports;
}

} // namespace

NODE_API_MODULE(mftvol, Init)
