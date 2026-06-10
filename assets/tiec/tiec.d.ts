export namespace tiec {
    /**
     * 行列位置描述，包含行号和列号
     */
    export class Position {
        line: number;
        column: number;
        index: number;
    }

    /**
     * 范围描述，包含起始位置和结束位置
     */
    export class Range {
        start: Position;
        end: Position;
    }

    /**
     * 源文件版本
     */
    export enum SourceVersion {
        /**
         * 结绳4.0版本的源文件
         */
        VERSION_4_0 = 40,
        /**
         * 结绳4.6版本的源文件
         */
        VERSION_4_6 = 46,
        /**
         * 结绳4.7版本的源文件
         */
        VERSION_4_7 = 47
    }

    /**
     * 编译器编译过程中的任务类型
     */
    export enum TaskKind {
        PARSE = 0,
        ENTER = 1,
        ATTRIBUTE = 2,
        LOWER = 3,
        FINAL = 4
    }

    /**
     * 日志等级
     */
    export enum LogLevel {
        DEBUG = 0,
        INFO = 1,
        WARNING = 2,
        ERROR = 3
    }

    /**
     * 编译器输出目标平台枚举定义
     */
    export enum TargetPlatform {
        UNDEFINED = 0,
        ANDROID = 1,
        HARMONY = 2,
        LINUX = 3,
        WINDOWS = 4,
        IOS = 5,
        APPLE = 6,
        HTML = 7
    }

    /**
     * 符号输出名模式
     */
    export enum FriendlyNameKind {
        /**
         * 随机 rn_xx 名称
         */
        RANDOM = 0,

        /**
         * 使用拼音
         */
        PINYIN = 1,

        /**
         * 保留原始中文名称
         */
        ORIGINAL = 2
    }

    /**
     * 编译部署模式
     */
    export enum BuildProfile {
        /**
         * 标准模式
         */
        STANDARD = 0,

        /**
         * 部署设计器模式
         */
        DESIGNER = 1,
    }

    /**
     * 编译时的诊断信息详情
     */
    export class Diagnostic {
        /**
         * 源文件的URI
         */
        uri: string;

        /**
         * 诊断发出的位置信息
         */
        range: Range;

        /**
         * 诊断信息的key，可用于做QuickFix
         */
        key: string;

        /**
         * 诊断信息
         */
        message: string;

        /**
         * 诊断信息等级(警告/错误)
         */
        level: LogLevel;
    }

    /**
     * Uri标准定义
     */
    export class Uri {
        static fromString(uriString: string): Uri;

        static create(scheme: string, path: string): Uri;

        getLocalPath(): string;
    }

    /**
     * 源代码文件接口定义
     */
    export interface Source {
        /**
         * 获取源文件名称
         */
        getName(): string;

        /**
         * 获取文件最后修改时间
         */
        lastModified(): number;

        /**
         * 读取源文件内容
         */
        readContent(): string;

        /**
         * 获取 文件URI
         */
        getUri(): Uri;

        /**
         * 获取路径
         */
        getPath(): string;
    }

    /**
     * 手动定义一个源文件对象
     * @param uri 源文件uri
     * @param content 源文件内容
     */
    export function defineSource(uri: string, content: string): Source;

    /**
     * 编译阶段监听
     */
    export interface TaskListener {
        /**
         * 阶段任务开始
         * @param kind 开始的阶段
         */
        onTaskBegin(kind: TaskKind): void;

        /**
         * 阶段任务结束
         * @param kind 结束的阶段
         */
        onTaskEnd(kind: TaskKind): void;
    }

    /**
     * 编译时诊断信息输出监听
     */
    export interface DiagnosticHandler {
        /**
         * 处理诊断信息输出
         * @param diagnostic 诊断信息详情
         */
        report(diagnostic: Diagnostic): void;
    }

    export class StringSet {
        add(element: string): void;
        remove(element: string): void;
        contains(element: string): boolean;
        isEmpty(): boolean;
        size(): number;
    }

    abstract class NativeList<T> {
        get(index: number): T;
        set(index: number, element: T): void;
        add(element: T): void;
        remove(element: T): void;
        isEmpty(): boolean;
        size(): number;
    }

    export class StringList extends NativeList<string> {
    }

    export class UriList extends NativeList<Uri> {
    }

    export class SourceList extends NativeList<Source> {
    }

    export class DiagnosticList extends NativeList<Diagnostic> {
    }

    export class AndroidAppConfig {
        appName: string;
        appIcon: string;
        minSdk: number;
        targetSdk: number;
        versionCode: number;
        versionName: string;
    }

    /**
     * 安卓平台的特殊配置
     */
    export class AndroidOptions {
        /**
         * App配置信息（如appName、minSdk等）
         */
        appConfig: AndroidAppConfig;

        /**
         * 是否输出为gradle工程格式
         */
        gradle: boolean;

        /**
         * 安卓基本库路径(用于兼容androidx不同版本aar搜寻)
         */
        foundationLibPath: string;
    }

    /**
     * 编译器编译选项
     */
    export class Options {
        /**
         * 结绳源文件版本
         */
        sourceVersion: SourceVersion;

        /**
         * 默认包名，对应 Options::package_name
         */
        packageName: string;

        /**
         * 输出路径，对应 Options::output_dir
         */
        outputDir: string;

        /**
         * 行号表输出路径，对应 Options::line_map_path
         */
        lineMapPath: string;

        /**
         * 是否为调试模式，对应 Options::line_map_path
         */
        debug: boolean;

        /**
         * 是否进行硬输出，所有用到的文件都拷贝到输出目录，而不是使用地址引用
         */
        hardMode: boolean;

        /**
         * 是否开启顶级语句语法特性支持
         */
        enableTopLevelStmt: boolean;

        /**
         * 友好名称输出模式
         */
        friendlyName: FriendlyNameKind;

        /**
         * 是否为IDE模式
         */
        ideMode: boolean;

        /**
         * 编译部署模式
         */
        profile: BuildProfile;

        /**
         * 优化级别
         * 0: 不优化
         * 1: 基础常量传播、常量折叠、死代码消除
         * 2: 1的基础上增加方法调用静态内联
         * 3: 2的基础上增加方法动态内联(直接解释运行方法生成最终常量结果)、循环变量外提、循环展开
         */
        optimizeLevel: number;

        /**
         * 要屏蔽的lint选项
         */
        lintDisable: StringSet;

        /**
         * 日志输出级别
         */
        logLevel: LogLevel;

        /**
         * 输出的目标平台
         */
        platform: TargetPlatform;

        /**
         * 稳定名称映射表输出路径
         */
        emitNamesPath: string;

        /**
         * 稳定名称映射表读取路径
         */
        stableNamesPath: string;

        /**
         * 附加搜寻路径
         * @param scope 搜索作用域
         * @param prefix 目录
         */
        addSearchPrefix(scope: string, prefix: string): void;

        /**
         * 定义编译条件宏
         */
        define(name: string, value?: string | number | boolean | null): void;

        /**
         * 设置Android平台编译时特殊配置
         * @param androidOptions AndroidOptions对象
         */
        setAndroidOptions(androidOptions: AndroidOptions): void;
    }

    /**
     * 编译器上下文，整个编译器的核心环境
     */
    export class Context {
        /**
         * 构造函数
         * @param options 编译选项
         */
        constructor(options: Options);
    }

    /**
     * 编译器接口
     */
    export class Compiler {
        constructor(context: Context);

        /**
         * 设置编译器的任务阶段监听
         * @param listener TaskListener实例
         */
        setTaskListener(listener: TaskListener): void;

        /**
         * 设置编译器编译过程中的诊断信息输出监听
         * @param handler DiagnosticHandler实例
         */
        setDiagnosticHandler(handler: DiagnosticHandler): void;

        /**
         * 编译源文件
         * @param files 源文件列表
         * @returns 编译成功返回true，编译过程中有错误返回false
         */
        compileFiles(files: string[]): boolean;

        /**
         * 编译自定义源文件
         * @param sources 自定义源文件列表
         * @returns 编译成功返回true，编译过程中有错误返回false
         */
        compileSources(sources: SourceList): boolean;
    }

    /**
     * 增量更新文本时的patch信息
     */
    export class TextChange {
        /**
         * 文本变更的范围
         */
        range: Range;

        /**
         * 变更后的文本
         */
        newText: string;
    }

    /**
     * 要执行的文本内容修改信息，IDE侧按照该信息将range对应的内容替换为newText
     */
    export class TextEdit {
        /**
         * 要修改的文本范围
         */
        range: Range;

        /**
         * 替换后文本
         */
        newText: string;
    }

    export class TextEditList extends NativeList<TextEdit> {
    }

    /**
     * 整个项目每个文件对应TextEdit的表
     */
    export class ProjectEditMap {
        keys(): UriList
        get(uri: Uri): TextEditList;
        put(uri: Uri, edits: TextEditList): void;
        contains(uri: Uri): boolean;
        isEmpty(): boolean;
        size(): number;
    }

    /**
     * 对整个IDE项目环境中文件的编辑信息描述
     */
    export class ProjectEdit {
        /**
         * 每个文件对应一个编辑序列
         */
        fileEdits: ProjectEditMap;
    }

    /**
     * 光标参数信息
     */
    export class CursorParams {
        /**
         * 当前文件Uri
         */
        uri: Uri;

        /**
         * 光标所处行列位置
         */
        position: Position;

        /**
         * 当前行文本(一般用不到，不需要传，作为保留字段)
         */
        lineText: string;
    }

    /**
     * 请求代码补全的参数信息
     */
    export class CompletionParams extends CursorParams {
        /**
         * 当前触发代码补全的前缀文本
         */
        partial: string;

        /**
         * 当前触发代码补全的字符
         */
        triggerChar: string;
    }

    /**
     * 代码补全类型枚举定义
     */
    export enum CompletionItemKind {
        KEYWORD = 0,
        SNIPPET = 1,
        CLASS = 2,
        VARIABLE = 3,
        METHOD = 4,
        GETTER = 5,
        SETTER = 6,
        EVENT_DECLARE = 7,
        ANNOTATION = 8,
        LITERAL = 9,
        FILE = 10
    }

    /**
     * 代码补全结果项信息定义
     */
    export class CompletionItem {
        /**
         * 代码补全类型
         */
        kind: CompletionItemKind;

        /**
         * 名称
         */
        label: string;

        /**
         * 详细描述信息
         */
        detail: string;

        /**
         * 用于排序的key
         */
        sortKey: string;

        /**
         * 符号名称，用于IDE统计符号使用频率，智能排序
         */
        symbolName: string;

        /**
         * 实际要插入到IDE编辑器中的内容
         */
        insertText: string;

        /**
         * 额外要执行的插入操作
         */
        extraEdits: TextEditList
    }

    export class CompletionItemList extends NativeList<CompletionItem> {
    }

    /**
     * 代码补全结果列表定义
     */
    export class CompletionResult {
        /**
         * 所有的代码补全项
         */
        items: CompletionItemList

        /**
         * 将结果转为json
         */
        toJson(): string;
    }

    /**
     * 文档类型枚举定义
     */
    export enum MarkupKind {
        /**
         * 纯文本
         */
        PLAIN_TEXT = 0,

        /**
         * Markdown格式
         */
        MARKDOWN = 1
    }

    /**
     * 文档内容描述信息
     */
    export class MarkupContent {
        /**
         * 文档类型
         */
        kind: MarkupKind;

        /**
         * 文档内容，需要根据 kind 进行不同的显示
         */
        text: string;

        /**
         * 将结果转为json
         */
        toJson(): string;
    }

    /**
     * 代码诊断结果
     */
    export class LintResult {
        /**
         * 所有的诊断信息(包含警告和错误)
         */
        diagnostics: DiagnosticList

        /**
         * 将结果转为json
         */
        toJson(): string;
    }

    /**
     * 符号类型定义
     */
    export enum ElementKind {
        /**
         * 未知类型
         */
        UNDEFINED = 0,

        /**
         * 类名
         */
        CLASS = 1,

        /**
         * 变量名
         */
        VARIABLE = 2,

        /**
         * 普通方法
         */
        COMMON_METHOD = 3,

        /**
         * 属性读方法
         */
        GETTER = 4,

        /**
         * 属性写方法
         */
        SETTER = 5,

        /**
         * 定义事件
         */
        EVENT_DECLARE = 6,

        /**
         * 事件
         */
        EVENT = 7,

        /**
         * 方法参数
         */
        PARAMETER = 8,

        /**
         * 注解
         */
        ANNOTATION = 9,

        /**
         * 类型参数
         */
        TYPE_PARAMETER = 10
    }

    /**
     * 符号标记类型枚举
     */
    export enum ElementTag {
        /**
         * 未定义tag
         */
        UNDEFINED = 0,

        /**
         * 静态
         */
        STATIC = 1,

        /**
         * 已废弃
         */
        DEPRECATED = 2
    }

    export class ElementTagList extends NativeList<ElementTag> {
    }

    /**
     * 语义高亮信息
     */
    export class SemanticHighlight {
        /**
         * 高亮区间
         */
        range: Range;

        /**
         * 高亮符号类型
         */
        kind: ElementKind;

        /**
         * 符号的属性（静态、废弃等）
         */
        tags: ElementTagList;
    }

    export class SemanticHighlightList extends NativeList<SemanticHighlight> {
    }

    /**
     * 语义高亮结果
     */
    export class HighlightResult {
        /**
         * 当前文件中所有语义高亮
         */
        highlights: SemanticHighlightList;

        /**
         * 将结果转为json
         */
        toJson(): string;
    }

    /**
     * 增量格式化结果
     */
    export class FormattingResult {
        /**
         * 对当前文件的编辑（一般是插入tab或删除tab）
         */
        edits: TextEditList;

        /**
         * 将结果转为json
         */
        toJson(): string;
    }

    /**
     * 符号描述信息
     */
    export class ElementInfo {
        /**
         * 符号类型
         */
        kind: ElementKind;

        /**
         * 符号属性
         */
        tags: ElementTagList

        /**
         * 符号名称
         */
        name: string;

        /**
         * 符号详细信息（方法签名、类的包名等）
         */
        detail: string;

        /**
         * 符号定义所在位置范围
         */
        range: Range;

        /**
         * 符号标识符区域
         */
        identifierRange: Range;
    }

    export class ElementInfoList extends NativeList<ElementInfo> {
    }

    /**
     * 每个源文件中符号结构信息
     */
    export class SourceElement {
        /**
         * 根节点符号信息
         */
        element: ElementInfo;

        /**
         * 子节点信息（向下嵌套）
         */
        children: SourceElementList;
    }

    export class SourceElementList extends NativeList<SourceElement> {
    }

    /**
     * 每个源文件中符号结构信息
     */
    export class SourceElementsResult {
        /**
         * 顶层符号信息节点
         */
        elements: SourceElementList;

        /**
         * 将结果转为json
         */
        toJson(): string;
    }

    /**
     * 项目中符号搜索结果
     */
    export class WorkspaceElementsResult {
        /**
         * 所有搜索到的符号
         * Key: 文件 URI
         * Value: 该文件对应的符号列表
         */
        elements: Record<string, ElementInfo[]>;

        /**
         * 将结果转为json
         */
        toJson(): string;
    }

    /**
     * SignatureHelp 请求的的参数信息
     */
    export class SignatureHelpParams extends CursorParams {
        /**
         * 触发SignatureHelp的字符
         */
        triggerChar: string;
    }

    /**
     * 方法签名提示
     */
    export class SignatureHelpResult {
        /**
         * 方法签名(包含方法名、参数名称和类型、返回类型s)
         */
        signature: string;

        /**
         * 当前正在输入的参数字段（可在方法签名中做字符串搜寻进行加粗显示）
         */
        activeParameter: string;

        /**
         * 将结果转为json
         */
        toJson(): string;
    }

    /**
     * 符号所处源代码位置信息描述
     */
    export class Location {
        /**
         * 所处文件Uri
         */
        uri: string;

        /**
         * 在文件中的文本范围
         */
        range: Range;
    }

    export class LocationList extends NativeList<Location> {
    }

    /**
     * 转到定义分析结果
     */
    export class DefinitionResult {
        /**
         * 符号标识符区域
         */
        identifierRange: Range;

        /**
         * 符号所在定义位置
         */
        location: Location;

        /**
         * 将结果转为json
         */
        toJson(): string;
    }

    /**
     * 符号引用分析结果
     */
    export class ReferenceResult {
        /**
         * 符号标识符区域
         */
        identifierRange: Range;

        /**
         * 符号在项目中所有引用处的位置信息描述
         */
        locations: LocationList;

        /**
         * 将结果转为json
         */
        toJson(): string;
    }

    /**
     * 光标处要重命名符号的详细信息
     */
    export class RenameSymbolInfo {
        /**
         * 符号名称
         */
        name: string;

        /**
         * 符号所处范围
         */
        range: Range;

        /**
         * 要重命名符号的类型
         */
        kind: ElementKind;
    }

    /**
     * 符号重命名结果，包含对整个项目中引用重命名符号源文件的修改
     */
    export class RenameResult {
        /**
         * 对整个项目文件的编辑
         */
        projectEdit: ProjectEdit;

        /**
         * 将结果转为json
         */
        toJson(): string;
    }

    /**
     * 智能键入类型枚举定义
     */
    export enum SmartEnterKind {
        /**
         * 不支持智能键入
         */
        UNDEFINED = 0,

        /**
         * 选择文件
         */
        FILE = 1,

        /**
         * 选择枚举属性
         */
        ENUMS = 2,

        /**
         * 真假开关
         */
        SWITCH = 3
    }

    /**
     * 智能键入
     */
    export class SmartEnterResult {
        /**
         * 类型（是选择文件还是选择属性，或者开关）
         */
        kind: SmartEnterKind;

        /**
         * 要替换/插入文本的位置
         */
        range: Range;

        /**
         * 用于替换的文本格式，这是一个需要格式化的字符串，会包含 %s 用于表示被替换的内容（路径/常量类型值/布尔值），
         * 比如为注解选择文件，也许这个格式为 "@外部依赖库(\"%s\")"，需要格式化后原封不动的去替换range之间的内容
         * 再比如为某个属性选择常量类型值，也许这个格式为 "文本1.对齐方式 = %s"，也有可能是 " = %s"或者直接"%s"，都需要格式化后原封不动的去替换range之间的内容
         */
        replaceFormat: string;

        /**
         * 在 SmartEnterKind 为 SmartEnterKind.Enums 时提供的选项
         */
        enums: StringList

        /**
         * 在 SmartEnterKind 为 SmartEnterKind.Switch 时提供的选项
         */
        isTrue: boolean;

        /**
         * 将结果转为json
         */
        toJson(): string;
    }

    /**
     * 生成事件、快速修复等CodeAction
     */
    export class CodeAction {
        /**
         * 标题
         */
        title: string;

        /**
         * 文本编辑列表
         */
        edits: TextEditList;
    }

    export class CodeActionList extends NativeList<CodeAction> {
    }

    /**
     * 单次代码操作请求的CodeAction集合
     */
    export class CodeActionResult {
        /**
         * CodeAction列表
         */
        actions: CodeActionList;

        /**
         * 将结果转为json
         */
        toJson(): string;
    }

    /**
     * TLY布局代码的序列化格式枚举定义
     */
    export enum TlySerializeFormat {
        /**
         * tly格式
         */
        TLY_FORMAT = 0,

        /**
         * json格式
         */
        JSON_FORMAT = 1
    }

    /**
     * tly布局解析结果
     */
    export class TLYParsingResult {
        /**
         * TLYEntity
         */
        root: TLYEntity;

        /**
         * 解析时错误信息
         */
        diagnostics: DiagnosticList;

        /**
         * 将结果转为json
         */
        toJson(): string;
    }

    /**
     * 当前类UI布局支持信息
     */
    export class UIBindingSupportInfo {
        /**
         * 是否支持设计布局
         */
        isSupport: boolean;

        /**
         * 所处类信息
         */
        element: ElementInfo;

        /**
         * 将结果转为json
         */
        toJson(): string;
    }

    /**
     * TLY布局变量编辑结果（包含对当前所处类的成员变量修改）
     */
    export class EditUIBindingsResult {
        /**
         * 对成员变量的修改(一般包含两项，一是删除原来的布局变量，二是插入新的布局变量)
         */
        edits: TextEditList;

        /**
         * 将结果转为json
         */
        toJson(): string;
    }

    /**
     * 可视化组件在布局设计器中可编辑属性信息
     */
    export class ViewEditableProperty {
        /**
         * 属性名称
         */
        name: string;

        /**
         * 属性类型(文本、整数、图片资源等)
         */
        type: string;

        /**
         * 属性输出名(原生封装组件时，会有输出名指定映射)
         */
        mangledName: string;
    }

    export class ViewEditablePropertyList extends NativeList<ViewEditableProperty> {
    }

    /**
     * 可视化组件类型信息
     */
    export class ViewClassInfo {
        /**
         * 完整类名
         */
        name: string;

        /**
         * 类名输出名
         */
        mangledName: string;

        /**
         * 是否为容器组件
         */
        isContainer: boolean;

        /**
         * 可编辑属性集(不包含基础属性)
         */
        viewProperties: ViewEditablePropertyList;

        /**
         * 布局组件对子组件提供的布局属性，如果不是布局组件，该项为空
         */
        containerProperties: ViewEditablePropertyList;
    }

    export class ViewClassInfoList extends NativeList<ViewClassInfo> {
    }

    /**
     * 可视化组件类型信息结果
     */
    export class ViewClassInfoResult {
        /**
         * 所有可视化组件的类型信息
         */
        viewClasses: ViewClassInfoList;

        /**
         * 所有可视化组件的基础属性
         */
        basicProperties: ViewEditablePropertyList;

        /**
         * 可视化组件运行时类名，反射时以该名称为准
         */
        componentClassName: string;

        /**
         * 布局组件运行时类名，反射时以该名称为准
         */
        layoutClassName: string;

        /**
         * 布局组件添加子组件方法运行时名称，反射时以该名称为准
         */
        layoutAddMethodName: string;

        /**
         * 未知组件运行时类名，反射时以该名称为准
         */
        unknownClassName: string;

        /**
         * 将结果转为json
         */
        toJson(): string;
    }

    /**
     * TLY组件节点
     */
    export class TLYEntity {

        /**
         * 将TLYEntity转为json
         */
        toJson(): string;
    }

    /**
     * IDE服务接口
     */
    export class IDEService {
        constructor(context: Context);

        /**
         * 打开项目时必须调用，用于预编译IDE环境中的所有源文件
         * @param files 源文件列表
         * @returns 编译成功返回true，编译过程中有错误返回false
         */
        compileFiles(files: string[]): boolean;

        /**
         * 打开项目时必须调用，用于预编译IDE环境中的所有源文件（自定义源文件，可绕过File api），便于后续进行增量编译
         * @param sources 源文件列表
         * @returns 编译成功返回true，编译过程中有错误返回false
         */
        compileSources(sources: SourceList): boolean;

        /**
         * 通知环境中代码文件被修改（全量更新）
         * @param uri 代码文件Uri
         * @param newContent 修改后的内容
         */
        didChangeSource(uri: string, newContent: string): void;

        /**
         * 通知环境中代码文件被修改（增量更新）
         * @param uri 代码文件Uri
         * @param change 增量修改的内容
         */
        didChangeSourceIncremental(uri: string, change: TextChange): void;

        /**
         * 通知环境中有新文件创建
         * @param uri 代码文件Uri
         * @param initialText 文件初始内容(一般为空)
         */
        didCreateSource(uri: string, initialText: string): void;

        /**
         * 通知环境中有文件被删除
         * @param uri 代码文件Uri
         */
        didDeleteSource(uri: string): void;

        /**
         * 通知环境中文件被重命名
         * @param uri 原来的Uri
         * @param newUri 重命名后的Uri
         */
        didRenameSource(uri: string, newUri: string): void;

        /**
         * 获取光标处的代码补全
         * @param params 代码补全参数
         * @returns 代码补全结果
         */
        complete(params: CompletionParams): CompletionResult | null;

        /**
         * 获取光标处的光标悬停结果
         * @param params 光标参数
         * @returns 光标悬停处的符号信息
         */
        hover(params: CursorParams): MarkupContent | null;

        /**
         * 对指定文件进行代码查错
         * @param uri 文件Uri
         * @returns 代码查错结果
         */
        lintFile(uri: string): LintResult | null;

        /**
         * 对所有文件都进行代码查错
         * @returns 代码查错结果
         */
        lintAll(): LintResult | null;

        /**
         * 对指定文件进行语义高亮
         * @param uri 文件Uri
         * @returns 语义高亮结果
         */
        highlight(uri: string): HighlightResult | null;

        /**
         * 对指定文件的行范围进行语义高亮
         * @param uri 文件Uri
         * @param startLine 起始行，0-based，包含
         * @param endLine 结束行，0-based，不包含
         * @returns 语义高亮结果
         */
        highlightRange(uri: string, startLine: number, endLine: number): HighlightResult | null;

        /**
         * 对指定文件进行格式化
         * @param uri 文件Uri
         * @returns 格式化结果
         */
        format(uri: string): FormattingResult | null;

        /**
         * 获取指定文件的符号嵌套结构(类->方法/变量->...)，包含每个符号的详细信息（符号名称、类型、定义位置等）
         * @param uri 文件Uri
         * @returns 符号嵌套结构
         */
        sourceElements(uri: string): SourceElementsResult | null;

        /**
         * 通过关键词搜索整个项目中结绳源代码符号
         * @param keyword 搜索关键词
         * @returns 包含搜索关键词的所有符号
         */
        workspaceElements(keyword: string): WorkspaceElementsResult | null;

        /**
         * 获取当前正在输入方法参数的签名信息
         * @param signatureHelpParams 请求SignatureHelp的参数(光标参数+触发字符)
         * @returns 方法签名参数信息
         */
        signatureHelp(signatureHelpParams: SignatureHelpParams): SignatureHelpResult | null;

        /**
         * 获取光标处符号原始定义位置
         * @param params 光标参数
         * @returns 符号定义位置
         */
        findDefinition(params: CursorParams): DefinitionResult | null;

        /**
         * 获取光标处符号所有被引用的地方
         * @param params 光标参数
         * @returns 符号引用的结果信息
         */
        findReferences(params: CursorParams): ReferenceResult | null;

        /**
         * 获取光标处要重命名的符号信息
         * @param params 光标参数
         * @returns 光标处要重命名符号的信息
         */
        prepareRename(params: CursorParams): RenameSymbolInfo | null;

        /**
         * 对光标处符号进行重命名
         * @param params 光标参数
         * @param newName 新的名称
         * @returns 重命名结果
         */
        rename(params: CursorParams, newName: string): RenameResult | null;

        /**
         * 获取智能键入操作（一般光标点击时调用）
         * @param params 光标参数
         * @returns 智能键入结果
         */
        smartEnter(params: CursorParams): SmartEnterResult | null;

        /**
         * 在光标处快捷生成事件定义
         * @param params 光标参数
         * @returns 生成事件结果
         */
        generateEvent(params: CursorParams): CodeActionResult | null;

        /**
         * 判断光标处所处类是否支持组件布局（仅安卓平台可用）
         * @param params 光标参数
         * @returns 当前类是否支持布局设计的相关信息
         */
        supportUIBinding(params: CursorParams): UIBindingSupportInfo;

        /**
         * 获取光标处所处类的组件布局信息（仅安卓平台可用）
         * @param params 光标参数
         * @param format TLY序列化格式(tly格式/json格式)
         * @returns TLY布局代码
         */
        getUIBindings(params: CursorParams, format: TlySerializeFormat): string | null;

        /**
         * 解析tly布局代码
         * @param tlyText tly布局代码
         * @returns TLY布局代码
         */
        parseTLYEntity(tlyText: string): TLYParsingResult | null;

        /**
         * 将光标处所处类原有的布局变量删除，并替换为新的TLY布局变量（仅安卓平台可用）
         * @param params 光标参数
         * @param newTlyData 新的TLY布局数据
         * @param format TLY序列化格式(tly格式/json格式)
         * @returns 当前代码文件的编辑结果，会将原有布局变量全部删除，然后插入新的布局变量
         */
        editUIBindings(params: CursorParams, newTlyData: string, format: TlySerializeFormat): EditUIBindingsResult | null;

        /**
         * 扫描整个编译环境中可视化组件类型信息，用于布局设计器支持设计布局
         * @returns 可视化组件类型信息
         */
        scanUIClasses(): ViewClassInfoResult | null;

        /**
         * 获取指定URI源文件的内容（可用于开发时检测内容同步是否成功
         * @param uri 源文件URI
         * @return 源文件内容
         */
        getSourceText(uri: Uri): string;

        /**
         * 取消上一次请求
         */
        cancel(): void;

        /**
         * 格式化代码文本（不包含任何语义，纯代码解析缩进）
         * @param docText 代码文本内容
         * @returns 格式化之后的代码文本
         */
        static formatText(docText: string): string;

        /**
         * 根据代码内容和光标位置获取处换行自动插入内容，如自动插入结束语句
         * @param docText 代码内容
         * @param position 光标换行位置
         * @returns 换行需要插入的内容，比如 "结束 如果"
         */
        static newLine(docText: string, position: Position): string;

        /**
         * 根据当前行文本解析获取下一行的缩进基数
         * @param lineText 当前行文本内容
         * @param column 光标所处列
         * @returns 下一行的缩进基数
         */
        static indentAdvance(lineText: string, column: number): number;
    }

    /**
     * 行号映射
     */
    export class SourceLine {
        /**
         * 对应结绳源文件的原始路径
         */
        path: string;

        /**
         * 对应结绳源代码中的原始行号
         */
        line: number;
    }

    /**
     * 行号表组件，用于还原结绳源代码原始行号和名称
     */
    export class SourceMapping {
        constructor(mappingPath: string);

        /**
         * 获取输出名在结绳源代码中的原始名称
         * @param mangledName 输出名(如rn_xx)
         * @returns 原始名称
         */
        getOriginalName(mangledName: string): string;

        /**
         * 从行号表获取输出文件行号对应的结绳源代码原始行号
         * @param filename 输出的文件名（不是路径）
         * @param outputLine 输出的文件行号
         * @returns SourceLine
         */
        getSourceLine(filename: string, outputLine: number): SourceLine | null;
    }
}

/**
 * Emscripten FS文件系统后端描述。
 */
export interface TiecFSBackend {
    mount(mount: TiecFSMount): unknown;
}

/**
 * Emscripten FS挂载记录。
 */
export interface TiecFSMount {
    type: TiecFSBackend;
    mountpoint: string;
    opts: Record<string, unknown> | null;
}

/**
 * NODEFS挂载参数。
 */
export interface TiecNodeFSOptions {
    root: string;
}

export interface TiecFileSystems {
    /**
     * Node.js文件系统桥接后端。
     */
    NODEFS: TiecFSBackend;
}

export interface TiecFS {
    /**
     * 已注册的文件系统后端。
     */
    filesystems: TiecFileSystems;

    /**
     * 获取当前工作目录。
     */
    cwd(): string;

    /**
     * 切换当前工作目录。
     */
    chdir(path: string): void;

    /**
     * 创建单级目录。
     */
    mkdir(path: string): void;

    /**
     * 递归创建目录。
     */
    mkdirTree(path: string): void;

    /**
     * 挂载文件系统后端。
     */
    mount(type: TiecFSBackend, opts: TiecNodeFSOptions | Record<string, unknown> | null, mountpoint: string): TiecFSMount;

    /**
     * 卸载文件系统。
     */
    unmount(mountpoint: string): void;

    readFile(path: string, options?: { encoding?: "utf8" | "binary"; flags?: string }): string | Uint8Array;
    writeFile(path: string, data: string | ArrayBufferView | ArrayBuffer, options?: { encoding?: "utf8" | "binary"; flags?: string }): void;
    unlink(path: string): void;
}

/**
 * 默认工厂函数返回的运行时模块对象。
 */
export type TiecModule = typeof tiec & {
    FS: TiecFS;
    addRunDependency(id: string): void;
    removeRunDependency(id: string): void;
    calledRun: boolean;
};

export interface TiecModuleFactoryOptions {
    locateFile?(path: string, prefix: string): string;
    print?(message?: unknown, ...optionalParams: unknown[]): void;
    printErr?(message?: unknown, ...optionalParams: unknown[]): void;
    onAbort?(reason: unknown): void;
    onRuntimeInitialized?(): void;
    preInit?: Array<() => void> | (() => void);
    preRun?: Array<(module: TiecModule) => void> | ((module: TiecModule) => void);
    postRun?: Array<(module: TiecModule) => void> | ((module: TiecModule) => void);
    monitorRunDependencies?(left: number): void;
    instantiateWasm?(
        imports: WebAssembly.Imports,
        successCallback: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void,
    ): void;
    preloadPlugins?: unknown[];
    wasmBinary?: ArrayBuffer | Uint8Array;
    arguments?: string[];
    thisProgram?: string;
    noFSInit?: boolean;
    noExitRuntime?: boolean;
    setStatus?(text: string): void;
}

declare function createTiec(module?: TiecModuleFactoryOptions): Promise<TiecModule>;

export default createTiec;
