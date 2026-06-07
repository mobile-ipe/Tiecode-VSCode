# 结绳开发工具

这个 VSCode 插件为结绳开发提供 `.t` / `.tly` 语言识别、编译器 IDE Service 接入、工程模板和构建命令。

## 功能

- `.t` 和 `.tly` 语法高亮、语言配置和片段。
- 通过结绳编译器 WASM IDE Service 提供补全、诊断、悬停、语义高亮、格式化、定义、引用、重命名、签名帮助和符号。
- 支持创建安卓工程、CXX 工程和网页工程。
- 支持调用本地 `tiec` 构建安卓、CXX 和网页工程。

## 工程结构

插件默认按 Mobile-IPE 的结绳工程习惯扫描：

- `源代码`
- `绳包/*/源代码`
- 编译器自带标准库中的 `安卓基本库`、`CXX基本库`、`网页基本库`

工程可通过 `tiecode.project.json` 声明类型、包名、源码版本和平台配置。

## 配置

默认编译器目录为 `D:\Projects\CrossPlatform\Tiecode-Compiler`。需要调整时修改：

- `tiecode.compiler.root`
- `tiecode.compiler.tiecPath`
- `tiecode.compiler.stdlibsPath`
- `tiecode.sourceVersion`
- `tiecode.project.platform`
