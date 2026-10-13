/**
 * 极简假 DOM：只实现本插件测试真正用到的那一小片 API。
 *
 * 客户端半的 DOM 注入桥（`src/account-button.js`）刻意只用这一小片：属性读写、
 * 父子关系、`insertBefore`、事件监听、以及 `tag[attr]` / `tag[attr="v"]` 形态的查询。
 * 这里如实实现它们，就能在没有浏览器的环境里把注入路径整条跑一遍。
 *
 * @module dsh-restart-desktop/test/fake-dom
 */

/** 一个假元素。 */
class FakeElement {
  /**
   * @param {string} tagName 标签名。
   * @param {FakeDocument | null} ownerDocument 所属文档。
   */
  constructor(tagName, ownerDocument = null) {
    this.tagName = tagName
    this.ownerDocument = ownerDocument
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.listeners = new Map()
    this.dataset = {}
    this.className = ''
    this.innerHTML = ''
    this.textContent = ''
    this.type = ''
    this.disabled = false
  }

  /** 与真实 DOM 同义（本假 DOM 的文本节点不参与结构）。 */
  get parentElement() {
    return this.parentNode
  }

  /** 根节点就是文档 body 时才算「在文档里」。 */
  get isConnected() {
    let node = this
    while (node.parentNode !== null && node.parentNode !== undefined) node = node.parentNode
    return node === this.ownerDocument?.body
  }

  get firstElementChild() {
    return this.children[0] ?? null
  }

  get nextSibling() {
    const siblings = this.parentNode?.children ?? []
    const index = siblings.indexOf(this)
    return index >= 0 ? siblings[index + 1] ?? null : null
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  appendChild(child) {
    return this.insertBefore(child, null)
  }

  insertBefore(child, reference) {
    child.remove()
    const index = reference === null || reference === undefined ? this.children.length : this.children.indexOf(reference)
    if (index < 0) throw new Error('insertBefore 的参照节点不是本节点的子节点')
    child.parentNode = this
    this.children.splice(index, 0, child)
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index < 0) throw new Error('removeChild 的子节点不存在')
    this.children.splice(index, 1)
    child.parentNode = null
    return child
  }

  remove() {
    if (this.parentNode !== null) this.parentNode.removeChild(this)
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event)
    return true
  }

  /**
   * 只支持 `tag`、`tag[attr]`、`tag[attr="value"]` 三种选择器。
   * @param {string} selector 选择器。
   * @returns {FakeElement[]} 命中的后代元素。
   */
  querySelectorAll(selector) {
    const found = []
    const visit = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) found.push(child)
        visit(child)
      }
    }
    visit(this)
    return found
  }
}

/**
 * 极简选择器匹配。
 * @param {FakeElement} element 元素。
 * @param {string} selector 选择器。
 * @returns {boolean} 命中时为 true。
 */
function matches(element, selector) {
  const parsed = /^([a-zA-Z]*)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/u.exec(selector)
  if (parsed === null) throw new Error(`假 DOM 不支持的选择器：${selector}`)
  const [, tag, attribute, value] = parsed
  if (tag !== '' && element.tagName.toLowerCase() !== tag.toLowerCase()) return false
  if (attribute === undefined) return true
  if (value === undefined) return element.hasAttribute(attribute)
  return element.getAttribute(attribute) === value
}

/** 一个假文档。 */
class FakeDocument {
  constructor() {
    this.body = new FakeElement('body', this)
    this.documentElement = this.body
  }

  createElement(tagName) {
    return new FakeElement(tagName, this)
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector)
  }
}

export { FakeDocument, FakeElement, matches }
