import { _interpolationEnd, _interpolationStart, DOM } from '../dom.js';
import { HTMLBindingDirective } from './binding.js';

let sharedContext = null;

class CompilationContext {
  addFactory(factory) {
    factory.targetIndex = this.targetIndex;

    this.behaviorFactories.push(factory);
  }

  captureContentBinding(directive) {
    directive.targetAtContent();
    this.addFactory(directive);
  }

  reset() {
    this.behaviorFactories = [];
    this.targetIndex = -1;
  }

  release() {
    sharedContext = this;
  }

  static borrow(directives) {
    const shareable = sharedContext || new CompilationContext();

    shareable.directives = directives;

    shareable.reset();

    sharedContext = null;

    return shareable;
  }
}

function createAggregateBinding(parts) {
  if (parts.length === 1) {
    return parts[0];
  }

  let targetName;
  const partCount = parts.length;

  const finalParts = parts.map((x) => {
    if (typeof x === 'string') {
      return () => x;
    }

    targetName = x.targetName || targetName;

    return x.binding;
  });

  const binding = (scope, context) => {
    let output = '';

    for (let i = 0; i < partCount; ++i) {
      output += finalParts[i](scope, context);
    }

    return output;
  };

  const directive = new HTMLBindingDirective(binding);

  directive.targetName = targetName;

  return directive;
}

const interpolationEndLength = _interpolationEnd.length;

function parseContent(context, value) {
  const valueParts = value.split(_interpolationStart);

  if (valueParts.length === 1) {
    return null;
  }

  const bindingParts = [];

  for (let i = 0, ii = valueParts.length; i < ii; ++i) {
    const current = valueParts[i];
    const index = current.indexOf(_interpolationEnd);
    let literal;

    if (index === -1) {
      literal = current;
    } else {
      const directiveIndex = parseInt(current.substring(0, index));

      bindingParts.push(context.directives[directiveIndex]);

      literal = current.substring(index + interpolationEndLength);
    }

    if (literal !== '') {
      bindingParts.push(literal);
    }
  }

  return bindingParts;
}

function compileAttributes(context, node, includeBasicValues = false) {
  const attributes = node.attributes;

  for (let i = 0, ii = attributes.length; i < ii; ++i) {
    const attr = attributes[i];
    const attrValue = attr.value;
    const parseResult = parseContent(context, attrValue);
    let result = null;

    if (parseResult === null) {
      if (includeBasicValues) {
        result = new HTMLBindingDirective(() => attrValue);

        result.targetName = attr.name;
      }
    } else {
      result = createAggregateBinding(parseResult);
    }

    if (result !== null) {
      node.removeAttributeNode(attr);
      i--;
      ii--;
      context.addFactory(result);
    }
  }
}

function compileContent(context, node, walker) {
  const parseResult = parseContent(context, node.textContent);

  if (parseResult !== null) {
    let lastNode = node;

    for (let i = 0, ii = parseResult.length; i < ii; ++i) {
      const currentPart = parseResult[i];
      const currentNode =
        i === 0
          ? node
          : lastNode.parentNode.insertBefore(
              document.createTextNode(''),
              lastNode.nextSibling
            );

      if (typeof currentPart === 'string') {
        currentNode.textContent = currentPart;
      } else {
        currentNode.textContent = ' ';

        context.captureContentBinding(currentPart);
      }

      lastNode = currentNode;

      context.targetIndex++;

      if (currentNode !== node) {
        walker.nextNode();
      }
    }

    context.targetIndex--;
  }
}

/**
 * Compiles a template and associated directives into a raw compilation
 * result which include a cloneable DocumentFragment and factories capable
 * of attaching runtime behavior to nodes within the fragment.
 * @param template - The template to compile.
 * @param directives - The directives referenced by the template.
 * @remarks
 * The template that is provided for compilation is altered in-place
 * and cannot be compiled again. If the original template must be preserved,
 * it is recommended that you clone the original and pass the clone to this API.
 * @public
 */
export function compileTemplate(template, directives) {
  const fragment = template.content;

  // https://bugs.chromium.org/p/chromium/issues/detail?id=1111864
  document.adoptNode(fragment);

  const context = CompilationContext.borrow(directives);

  compileAttributes(context, template, true);

  const hostBehaviorFactories = context.behaviorFactories;

  context.reset();

  const walker = DOM.createTemplateWalker(fragment);

  let node;

  while ((node = walker.nextNode())) {
    context.targetIndex++;

    switch (node.nodeType) {
      case 1: // element node
        compileAttributes(context, node);

        break;
      case 3: // text node
        compileContent(context, node, walker);

        break;
      case 8: // comment
        if (DOM.isMarker(node)) {
          context.addFactory(
            directives[DOM.extractDirectiveIndexFromMarker(node)]
          );
        }
    }
  }

  let targetOffset = 0;

  if (
    // If the first node in a fragment is a marker, that means it's an unstable first node,
    // because something like a when, repeat, etc. could add nodes before the marker.
    // To mitigate this, we insert a stable first node. However, if we insert a node,
    // that will alter the result of the TreeWalker. So, we also need to offset the target index.
    DOM.isMarker(fragment.firstChild) ||
    // Or if there is only one node and a directive, it means the template's content
    // is *only* the directive. In that case, HTMLView.dispose() misses any nodes inserted by
    // the directive. Inserting a new node ensures proper disposal of nodes added by the directive.
    (fragment.childNodes.length === 1 && directives.length)
  ) {
    fragment.insertBefore(document.createComment(''), fragment.firstChild);

    targetOffset = -1;
  }

  const viewBehaviorFactories = context.behaviorFactories;

  context.release();

  return {
    fragment,
    viewBehaviorFactories,
    hostBehaviorFactories,
    targetOffset
  };
}
