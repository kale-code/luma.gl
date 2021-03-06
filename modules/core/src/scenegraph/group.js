import Node from './scenegraph-node';
import {Matrix4} from 'math.gl';
import {log} from '../utils';
import assert from '../utils/assert';

export default class Group extends Node {
  constructor(opts = {}) {
    opts = Array.isArray(opts) ? {children: opts} : opts;
    const {children = []} = opts;
    children.every(child => assert(child instanceof Node));
    super(opts);
    this.children = children;
  }

  // Unpacks arrays and nested arrays of children
  add(...children) {
    for (const child of children) {
      if (Array.isArray(child)) {
        this.add(...child);
      } else {
        this.children.push(child);
      }
    }
    return this;
  }

  remove(child) {
    const children = this.children;
    const indexOf = children.indexOf(child);
    if (indexOf > -1) {
      children.splice(indexOf, 1);
    }
    return this;
  }

  removeAll() {
    this.children = [];
    return this;
  }

  traverse(visitor, {worldMatrix = new Matrix4()} = {}) {
    const modelMatrix = new Matrix4(worldMatrix).multiplyRight(this.matrix);

    for (const child of this.children) {
      if (child instanceof Group) {
        child.traverse(visitor, {worldMatrix: modelMatrix});
      } else {
        visitor(child, {worldMatrix: modelMatrix});
      }
    }
  }

  traverseReverse(visitor, opts) {
    log.warn('traverseReverse is not reverse')();
    return this.traverse(visitor, opts);
  }
}
