{
  "targets": [
    {
      "target_name": "mftvol",
      "sources": ["addon.cc"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "msvs_settings": {
        "VCCLCompilerTool": { "AdditionalOptions": ["/std:c++17"] }
      },
      "configurations": {
        "Release": { "msbuild_toolset": "v143" },
        "Debug": { "msbuild_toolset": "v143" }
      }
    }
  ]
}
