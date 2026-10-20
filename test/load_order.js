/**
 * @fileoverview Checks the load order of the app scripts.
 *
 * The files in IPTVUltra/js/ are classic scripts that share one global scope.
 * A function declaration is hoisted only within its own file. Thus, code that
 * runs at load time must not use a function from a later file: that function
 * is not yet defined, and the app stops at start-up with a ReferenceError.
 *
 * This script reads the script order from index.html, finds the code that
 * runs at load time in each file, follows the functions that this code calls,
 * and reports each function that is declared in a later file.
 *
 * Usage: node load_order.js   (exit code 1 when it finds a problem)
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const APP = path.join(__dirname, '..', 'IPTVUltra');

// Calls whose function arguments run later, not at load time.
const DEFERRED_CALLS = new Set([
  'addEventListener',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'requestIdleCallback',
  'then',
  'catch',
  'finally',
  'queueMicrotask',
]);

const isFunction = (node) => /Function/.test(node.type);

/**
 * @param {!Object} callee
 * @return {boolean} True when the call runs its function arguments later.
 */
function isDeferredCall(callee) {
  let name = '';
  if (callee.type === 'Identifier') {
    name = callee.name;
  } else if (callee.type === 'MemberExpression' && !callee.computed) {
    name = callee.property.name;
  }
  return DEFERRED_CALLS.has(name);
}

/**
 * Returns the identifiers that run when `node` runs. Function bodies are
 * skipped when the function runs later: a function declaration, a function
 * passed to a deferred call, an on* handler, or a top-level const bound to a
 * function. Other function expressions (forEach callbacks, IIFEs) run now.
 * @param {!Object} node
 * @return {!Array<!Object>}
 */
function eagerRefs(node) {
  const refs = [];
  walk.recursive(node, null, {
    Identifier(id) {
      refs.push(id);
    },
    FunctionDeclaration() {},
    FunctionExpression(f, st, c) {
      c(f.body);
    },
    ArrowFunctionExpression(f, st, c) {
      c(f.body);
    },
    CallExpression(call, st, c) {
      c(call.callee);
      for (const arg of call.arguments) {
        if (!(isFunction(arg) && isDeferredCall(call.callee))) c(arg);
      }
    },
    AssignmentExpression(asg, st, c) {
      const onHandler = asg.left.type === 'MemberExpression' &&
          !asg.left.computed && /^on/.test(asg.left.property.name) &&
          isFunction(asg.right);
      c(asg.left);
      if (!onHandler) c(asg.right);
    },
    MemberExpression(mem, st, c) {
      c(mem.object);
      if (mem.computed) c(mem.property);
    },
    Property(prop, st, c) {
      if (prop.computed) c(prop.key);
      c(prop.value);
    },
    VariableDeclarator(decl, st, c) {
      const topLevel = node.type === 'VariableDeclaration' &&
          node.declarations.includes(decl);
      if (decl.init && !(topLevel && isFunction(decl.init))) c(decl.init);
    },
  });
  return refs;
}

/** @return {!Array<string>} The app scripts in the order of index.html. */
function scriptOrder() {
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  return [...html.matchAll(/<script src="(js\/[^"]+)"/g)].map((m) => m[1]);
}

function main() {
  const files = scriptOrder();
  if (!files.length) throw new Error('no js/ scripts found in index.html');

  // Top-level functions of all files: name -> {file index, node}.
  const functions = new Map();
  const programs = files.map((file, index) => {
    const src = fs.readFileSync(path.join(APP, file), 'utf8');
    const program = acorn.parse(src, {ecmaVersion: 'latest', locations: true});
    for (const st of program.body) {
      if (st.type === 'FunctionDeclaration') {
        functions.set(st.id.name, {index, node: st});
      } else if (st.type === 'VariableDeclaration') {
        for (const decl of st.declarations) {
          if (decl.id.type === 'Identifier' && decl.init &&
              isFunction(decl.init)) {
            functions.set(decl.id.name, {index, node: decl.init});
          }
        }
      }
    }
    return program;
  });

  const bodyRefs = new Map();
  const refsOfFunction = (name) => {
    if (!bodyRefs.has(name)) {
      bodyRefs.set(name, eagerRefs(functions.get(name).node.body));
    }
    return bodyRefs.get(name);
  };

  let problems = 0;
  programs.forEach((program, index) => {
    const seen = new Set();
    const queue = [];
    for (const st of program.body) {
      if (st.type === 'FunctionDeclaration') continue;
      for (const id of eagerRefs(st)) {
        queue.push({id, via: `${files[index]}:${id.loc.start.line}`});
      }
    }
    while (queue.length) {
      const {id, via} = queue.shift();
      const fn = functions.get(id.name);
      if (!fn) continue;
      if (fn.index > index) {
        problems++;
        console.log(`${files[index]} uses ${id.name} from ${
            files[fn.index]} at load time (${via})`);
      }
      if (!seen.has(id.name)) {
        seen.add(id.name);
        for (const ref of refsOfFunction(id.name)) {
          queue.push({id: ref, via: `${via} > ${id.name}`});
        }
      }
    }
  });

  if (problems) {
    console.log(`${problems} load-order problems`);
    process.exit(1);
  }
  console.log(`load order OK (${files.length} files)`);
}

main();
