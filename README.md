# 结绳开发工具

这个 VSCode 插件为结绳开发提供 `.t` / `.tly` 语言识别、编译器 IDE Service 接入、工程模板和构建命令。

## 功能

- `.t` 和 `.tly` 语法高亮、语言配置和片段，默认使用 SweetLine WASM 提供接近 Mobile-IPE 的高亮规则。
- 通过结绳编译器 WASM IDE Service 提供补全、诊断、悬停、语义高亮、格式化、定义、引用、重命名、签名帮助和符号。
- `.tly` 支持布局诊断、格式化，以及基于安卓可视化组件扫描结果的组件名和属性名补全。
- 支持创建安卓工程、CXX 工程和网页工程，并复制对应基本库到工程 `绳包` 目录。
- 支持调用本地 `tiec` 构建安卓、CXX 和网页工程；安卓工程会按调试包/正式包自动执行 Gradle 构建，CXX 工程会自动执行 CMake 配置和构建。
- 支持 F5 运行当前工程；安卓调试包会安装并启动生成的 launcher Activity，CXX 工程会启动生成的可执行文件，网页工程会打开生成页面。
- 提供结绳运行配置视图，可编辑工程类型、打包模式、SDK 版本、包名、图标、宏定义，并查看和修复 Java、Android SDK、adb、Gradle 环境。

## 工程结构

插件默认按 Mobile-IPE 的结绳工程习惯扫描：

- `源代码`
- `绳包/*/源代码`
- 编译器自带标准库中的 `安卓基本库`、`CXX基本库`、`网页基本库`

创建新工程时，插件会从 `tiecode.compiler.stdlibsPath` 复制对应的 `安卓基本库`、`CXX基本库` 或 `网页基本库` 到工程 `绳包` 目录，保持和 Mobile-IPE 工程结构一致。

工程优先读取 Mobile-IPE 的 `project.json`，会识别 `app_name`、`app_pkg`、`min_sdk`、`target_sdk`、`version_code`、`version_name`、`icon_path`、`source_version`、`project_version` 等字段。`tiecode.project.json` 可作为 VSCode 专用覆盖配置。

## 配置

默认编译器目录为 `D:\Projects\CrossPlatform\Tiecode-Compiler`。需要调整时修改：

- `tiecode.compiler.root`
- `tiecode.compiler.tiecPath`
- `tiecode.compiler.stdlibsPath`
- `tiecode.highlight.engine`
- `tiecode.sourceVersion`
- `tiecode.project.platform`
- `tiecode.build.mode`
- `tiecode.build.defines`
- `tiecode.android.gradle`
- `tiecode.cxx.runCmake`
- `tiecode.cxx.executableName`
- `tiecode.cxx.cmakeGenerator`
- `tiecode.cxx.cmakeBuildType`

`tiecode.highlight.engine` 默认为 `hybrid`，会优先使用 SweetLine WASM，高亮不可用时回退到编译器 IDE Service。也可以设置为 `sweetline`、`compiler` 或 `textmate`。
