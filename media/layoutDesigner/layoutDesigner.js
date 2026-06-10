(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  let state = clone(window.__TIECODE_LAYOUT_DESIGNER_STATE__);
  let root = clone(state.root);
  let selectedPath = [];
  let activeTab = "components";
  let searchText = "";
  let clipboard = null;
  let dirty = false;
  let saving = false;

  function clone(value) {
    return JSON.parse(JSON.stringify(value ?? null));
  }

  function render() {
    app.innerHTML = "";
    const shell = el("div", "designer");
    shell.append(renderToolbar());
    const main = el("div", "main");
    main.append(renderLeftPanel(), renderCanvasPanel(), renderInspector());
    shell.append(main);
    app.append(shell);
  }

  function renderToolbar() {
    const toolbar = el("div", "toolbar");
    toolbar.append(
      el("div", "toolbar-title", state.title || "布局设计器"),
      el("div", "toolbar-path", state.sourcePath || ""),
      button(saving ? "保存中" : "保存", "save", () => save(), undefined, saving),
      button("刷新", "secondary", () => vscode.postMessage({ command: "refresh" })),
      el("div", "toolbar-status", dirty ? "未保存" : "已同步")
    );
    return toolbar;
  }

  function renderLeftPanel() {
    const panel = el("aside", "side");
    const tabs = el("div", "panel-tabs");
    tabs.append(
      tabButton("components", "组件"),
      tabButton("tree", "结构")
    );
    const body = el("div", "panel-body");
    if (activeTab === "components") {
      body.append(renderComponents());
    } else {
      body.append(renderTree());
    }
    panel.append(tabs, body);
    return panel;
  }

  function renderCanvasPanel() {
    const panel = el("main", "canvas-shell");
    const actions = el("div", "canvas-actions");
    actions.append(
      button("↑", "icon secondary", () => moveSelected(-1), "上移"),
      button("↓", "icon secondary", () => moveSelected(1), "下移"),
      button("复制", "secondary", copySelected),
      button("粘贴", "secondary", pasteSelected),
      button("删除", "secondary", deleteSelected),
      el("div", "spacer"),
      button("适配", "secondary", () => {
        selectedPath = [];
        render();
      })
    );
    const wrap = el("div", "canvas-wrap");
    const device = el("div", "device");
    device.append(renderPreviewNode(root, []));
    wrap.append(device);
    panel.append(actions, wrap);
    return panel;
  }

  function renderInspector() {
    const panel = el("aside", "inspector");
    panel.append(el("div", "panel-tabs", el("button", "panel-tab active", "属性")));
    const body = el("div", "panel-body");
    const node = getNode(selectedPath);
    if (!node) {
      body.append(el("div", "empty", "未选择组件"));
    } else {
      body.append(renderProperties(node));
    }
    panel.append(body);
    return panel;
  }

  function renderComponents() {
    const fragment = document.createDocumentFragment();
    const search = el("input", "search");
    search.placeholder = "搜索组件";
    search.value = searchText;
    search.addEventListener("input", () => {
      searchText = search.value;
      render();
    });
    fragment.append(search);
    const groups = [
      ["组件", state.viewClasses.filter(item => !item.isContainer)],
      ["布局", state.viewClasses.filter(item => item.isContainer)]
    ];
    for (const [title, items] of groups) {
      const filtered = items.filter(matchesSearch);
      if (filtered.length === 0) {
        continue;
      }
      fragment.append(el("div", "section-title", title));
      const list = el("div", "component-list");
      for (const item of filtered) {
        const row = button("", "component-item", () => addComponent(item));
        row.append(
          el("span", "component-mark", item.isContainer ? "□" : "·"),
          el("span", "component-name", displayClassName(item.name))
        );
        row.title = item.name;
        list.append(row);
      }
      fragment.append(list);
    }
    return fragment;
  }

  function renderTree() {
    const list = el("div", "tree-list");
    appendTreeNode(list, root, [], 0);
    return list;
  }

  function appendTreeNode(list, node, path, depth) {
    const row = button("", `tree-item${samePath(path, selectedPath) ? " active" : ""}`, () => {
      selectedPath = path;
      activeTab = "tree";
      render();
    });
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.append(
      el("span", "tree-mark", isContainer(node) ? "□" : "·"),
      el("span", "tree-name", entityName(node) || displayClassName(entityClassName(node)))
    );
    row.title = entityClassName(node);
    list.append(row);
    childrenOf(node).forEach((child, index) => appendTreeNode(list, child, path.concat(index), depth + 1));
  }

  function renderPreviewNode(node, path) {
    const className = entityClassName(node);
    const type = previewType(className);
    const box = el("div", `preview-node ${isContainer(node) ? "layout" : ""} ${orientationClass(node)}${samePath(path, selectedPath) ? " selected" : ""}`);
    applyPreviewStyle(box, node);
    box.addEventListener("click", event => {
      event.stopPropagation();
      selectedPath = path;
      render();
    });
    box.append(el("div", "preview-label", entityName(node) || displayClassName(className)));
    if (isContainer(node)) {
      const children = childrenOf(node);
      if (children.length === 0) {
        box.append(el("div", "preview-widget", displayClassName(className)));
      } else {
        children.forEach((child, index) => box.append(renderPreviewNode(child, path.concat(index))));
      }
      return box;
    }

    const widget = el("div", `preview-widget ${type}`);
    if (type === "list") {
      widget.append(el("span"), el("span"), el("span"));
    } else {
      widget.textContent = previewText(node, className);
    }
    box.append(widget);
    return box;
  }

  function renderProperties(node) {
    const fragment = document.createDocumentFragment();
    const viewClass = findViewClass(entityClassName(node));
    const parent = getParentNode(selectedPath);
    const parentClass = parent ? findViewClass(entityClassName(parent)) : undefined;
    const groups = [
      ["标识", [{ name: "名称", type: "文本", special: "name" }]],
      ["基础属性", state.basicProperties],
      ["组件属性", viewClass?.viewProperties || []],
      ["父布局属性", parentClass?.containerProperties || []]
    ];

    for (const [title, properties] of groups) {
      const unique = uniqueProperties(properties);
      if (unique.length === 0) {
        continue;
      }
      fragment.append(el("div", "section-title", title));
      const group = el("div", "property-group");
      unique.forEach(property => group.append(renderPropertyRow(node, property, title === "父布局属性")));
      fragment.append(group);
    }
    return fragment;
  }

  function renderPropertyRow(node, property, isLayoutProperty) {
    const row = el("label", "property-row");
    row.append(el("span", "property-name", property.name));
    const input = createPropertyInput(node, property, isLayoutProperty);
    row.append(input);
    return row;
  }

  function createPropertyInput(node, property, isLayoutProperty) {
    const type = property.type || "";
    const current = property.special === "name"
      ? entityName(node)
      : propertyValue(node, property.name, isLayoutProperty);
    if (isBooleanType(type)) {
      const input = el("input");
      input.type = "checkbox";
      input.checked = Boolean(current);
      input.addEventListener("change", () => updateProperty(node, property, input.checked, isLayoutProperty));
      return input;
    }

    const input = el("input");
    input.type = isNumberType(type) ? "number" : "text";
    input.value = current === undefined || current === null ? "" : String(current);
    input.addEventListener("change", () => updateProperty(node, property, parseInputValue(input.value, type), isLayoutProperty));
    return input;
  }

  function updateProperty(node, property, value, isLayoutProperty) {
    if (property.special === "name") {
      setEntityName(node, String(value || ""));
    } else {
      setPropertyValue(node, property.name, value, isLayoutProperty);
    }
    dirty = true;
    render();
  }

  function addComponent(viewClass) {
    const targetPath = insertionPath();
    const parent = getNode(targetPath);
    if (!parent || !isContainer(parent)) {
      setStatus("请选择布局组件");
      return;
    }
    const child = createEntity(viewClass);
    childrenOf(parent).push(child);
    selectedPath = targetPath.concat(childrenOf(parent).length - 1);
    activeTab = "tree";
    dirty = true;
    render();
  }

  function insertionPath() {
    const selected = getNode(selectedPath);
    if (selected && isContainer(selected)) {
      return selectedPath;
    }
    return selectedPath.length > 0 ? selectedPath.slice(0, -1) : [];
  }

  function deleteSelected() {
    if (selectedPath.length === 0) {
      setStatus("根布局不能删除");
      return;
    }
    const parent = getParentNode(selectedPath);
    if (!parent) {
      return;
    }
    childrenOf(parent).splice(selectedPath[selectedPath.length - 1], 1);
    selectedPath = selectedPath.slice(0, -1);
    dirty = true;
    render();
  }

  function moveSelected(offset) {
    if (selectedPath.length === 0) {
      return;
    }
    const parent = getParentNode(selectedPath);
    if (!parent) {
      return;
    }
    const index = selectedPath[selectedPath.length - 1];
    const next = index + offset;
    const siblings = childrenOf(parent);
    if (next < 0 || next >= siblings.length) {
      return;
    }
    const [node] = siblings.splice(index, 1);
    siblings.splice(next, 0, node);
    selectedPath = selectedPath.slice(0, -1).concat(next);
    dirty = true;
    render();
  }

  function copySelected() {
    const node = getNode(selectedPath);
    if (node) {
      clipboard = clone(node);
      setStatus("已复制");
    }
  }

  function pasteSelected() {
    if (!clipboard) {
      setStatus("没有可粘贴组件");
      return;
    }
    const targetPath = insertionPath();
    const parent = getNode(targetPath);
    if (!parent || !isContainer(parent)) {
      return;
    }
    const pasted = clone(clipboard);
    renameTree(pasted);
    childrenOf(parent).push(pasted);
    selectedPath = targetPath.concat(childrenOf(parent).length - 1);
    dirty = true;
    render();
  }

  function save() {
    if (saving) {
      return;
    }
    saving = true;
    render();
    vscode.postMessage({ command: "save", root });
  }

  function createEntity(viewClass) {
    const name = generateName(displayClassName(viewClass.name));
    return {
      class: { className: viewClass.name },
      nameProp: createProperty("名称", name),
      properties: [
        createProperty("宽度", viewClass.isContainer ? -1 : -2),
        createProperty("高度", -2)
      ],
      children: []
    };
  }

  function createProperty(name, value, isAt) {
    return {
      propName: { name },
      propValue: { value },
      isAt: Boolean(isAt)
    };
  }

  function getNode(path) {
    let node = root;
    for (const index of path) {
      node = childrenOf(node)[index];
      if (!node) {
        return undefined;
      }
    }
    return node;
  }

  function getParentNode(path) {
    return path.length === 0 ? undefined : getNode(path.slice(0, -1));
  }

  function childrenOf(node) {
    if (!Array.isArray(node.children)) {
      node.children = [];
    }
    return node.children;
  }

  function entityClassName(node) {
    return node?.class?.className || node?.typeClass?.className || "";
  }

  function entityName(node) {
    return node?.nameProp?.propValue?.value ? String(node.nameProp.propValue.value) : "";
  }

  function setEntityName(node, name) {
    if (!node.nameProp) {
      node.nameProp = createProperty("名称", name);
      return;
    }
    node.nameProp.propName = { name: "名称" };
    node.nameProp.propValue = { value: name };
  }

  function propertyValue(node, name, isAt) {
    const prop = findProperty(node, name, isAt);
    return prop?.propValue?.value;
  }

  function setPropertyValue(node, name, value, isAt) {
    if (!Array.isArray(node.properties)) {
      node.properties = [];
    }
    let prop = findProperty(node, name, isAt);
    if (!prop) {
      prop = createProperty(name, value, isAt);
      node.properties.push(prop);
    }
    prop.propName = { name };
    prop.propValue = { value };
    prop.isAt = Boolean(isAt);
  }

  function findProperty(node, name, isAt) {
    return (node.properties || []).find(prop => prop?.propName?.name === name && Boolean(prop.isAt) === Boolean(isAt));
  }

  function isContainer(node) {
    return Boolean(findViewClass(entityClassName(node))?.isContainer);
  }

  function findViewClass(className) {
    const simple = displayClassName(className);
    return state.viewClasses.find(item =>
      item.name === className ||
      item.mangledName === className ||
      displayClassName(item.name) === simple ||
      displayClassName(item.mangledName || "") === simple
    );
  }

  function displayClassName(className) {
    const value = String(className || "");
    const index = Math.max(value.lastIndexOf("."), value.lastIndexOf("。"));
    return index >= 0 ? value.slice(index + 1) : value;
  }

  function generateName(base) {
    const names = new Set();
    collectNames(root, names);
    let index = 1;
    let candidate = `${base}${index}`;
    while (names.has(candidate)) {
      index += 1;
      candidate = `${base}${index}`;
    }
    return candidate;
  }

  function collectNames(node, target) {
    const name = entityName(node);
    if (name) {
      target.add(name);
    }
    childrenOf(node).forEach(child => collectNames(child, target));
  }

  function renameTree(node) {
    setEntityName(node, generateName(displayClassName(entityClassName(node))));
    childrenOf(node).forEach(renameTree);
  }

  function uniqueProperties(properties) {
    const seen = new Set();
    const result = [];
    for (const property of properties || []) {
      if (!property?.name || seen.has(property.name)) {
        continue;
      }
      seen.add(property.name);
      result.push(property);
    }
    return result;
  }

  function isBooleanType(type) {
    return /逻辑|布尔|Boolean|bool/i.test(type || "");
  }

  function isNumberType(type) {
    return /整数|小数|数字|number|int|float|double/i.test(type || "");
  }

  function parseInputValue(value, type) {
    if (isNumberType(type) && value !== "") {
      return type.includes("整数") ? Number.parseInt(value, 10) : Number(value);
    }
    if (value === "真") {
      return true;
    }
    if (value === "假") {
      return false;
    }
    return value;
  }

  function previewType(className) {
    const simple = displayClassName(className);
    if (/按钮/.test(simple)) {
      return "button";
    }
    if (/图片|图像/.test(simple)) {
      return "image";
    }
    if (/列表|表格|下拉/.test(simple)) {
      return "list";
    }
    return "";
  }

  function previewText(node, className) {
    return String(propertyValue(node, "内容", false) ?? entityName(node) ?? displayClassName(className));
  }

  function orientationClass(node) {
    const vertical = propertyValue(node, "纵向布局", false);
    return vertical === false || vertical === "假" ? " horizontal" : " vertical";
  }

  function applyPreviewStyle(box, node) {
    const width = cssSize(propertyValue(node, "宽度", false), "width");
    const height = cssSize(propertyValue(node, "高度", false), "height");
    const padding = cssUnit(propertyValue(node, "内边距", false));
    const margin = cssUnit(propertyValue(node, "外边距", true) ?? propertyValue(node, "外边距", false));
    const background = cssColor(propertyValue(node, "背景颜色", false));
    if (width) {
      box.style.width = width;
    }
    if (height) {
      box.style.minHeight = height;
    }
    if (padding) {
      box.style.padding = padding;
    }
    if (margin) {
      box.style.margin = margin;
    }
    if (background) {
      box.style.background = background;
    }
  }

  function cssSize(value, axis) {
    if (value === undefined || value === null || value === "") {
      return "";
    }
    if (value === -1 || value === "-1") {
      return "100%";
    }
    if (value === -2 || value === "-2") {
      return axis === "height" ? "28px" : "auto";
    }
    return cssUnit(value);
  }

  function cssUnit(value) {
    if (value === undefined || value === null || value === "") {
      return "";
    }
    if (typeof value === "number") {
      return `${Math.max(0, value)}px`;
    }
    const text = String(value).trim();
    if (/^-?\d+(\.\d+)?$/.test(text)) {
      return `${Math.max(0, Number(text))}px`;
    }
    return text.replace(/dp|sp/g, "px");
  }

  function cssColor(value) {
    if (typeof value !== "string") {
      return "";
    }
    const text = value.trim();
    return /^#|rgb|hsl|var\(/i.test(text) ? text : "";
  }

  function matchesSearch(item) {
    if (!searchText.trim()) {
      return true;
    }
    const keyword = searchText.trim().toLowerCase();
    return item.name.toLowerCase().includes(keyword) || displayClassName(item.name).toLowerCase().includes(keyword);
  }

  function samePath(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function setStatus(text) {
    const status = document.querySelector(".toolbar-status");
    if (status) {
      status.textContent = text;
      setTimeout(() => render(), 900);
    }
  }

  function tabButton(name, text) {
    return button(text, `panel-tab${activeTab === name ? " active" : ""}`, () => {
      activeTab = name;
      render();
    });
  }

  function button(text, className, handler, title, disabled) {
    const item = el("button", className, text);
    item.type = "button";
    item.disabled = Boolean(disabled);
    if (title) {
      item.title = title;
    }
    item.addEventListener("click", handler);
    return item;
  }

  function el(tag, className, text) {
    const item = document.createElement(tag);
    if (className) {
      item.className = className;
    }
    if (text !== undefined) {
      if (typeof text === "string" || typeof text === "number") {
        item.textContent = String(text);
      } else {
        item.append(text);
      }
    }
    return item;
  }

  window.addEventListener("message", event => {
    const message = event.data;
    if (message?.command === "load") {
      state = clone(message.state);
      root = clone(state.root);
      selectedPath = [];
      dirty = false;
      saving = false;
      render();
    }
    if (message?.command === "saved") {
      saving = false;
      dirty = false;
      render();
    }
    if (message?.command === "saveFailed") {
      saving = false;
      setStatus("保存失败");
    }
  });

  render();
}());
