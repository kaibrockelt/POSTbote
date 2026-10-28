// Drag & drop of requests and folders in the sidebar.
import { moveRequest, moveFolderInto } from './actions.js';

export const dnd = $state({ item: null, target: null }); // item: { kind: 'request' | 'folder', path }

export function dragStart(e, item) {
  dnd.item = item;
  e.dataTransfer.effectAllowed = 'move';
  // some webviews only start a drag when data is set
  e.dataTransfer.setData('text/plain', item.path);
}

export function dragEnd() {
  dnd.item = null;
  dnd.target = null;
}

/** Whether the dragged item may be dropped into folder `dir`. */
function allowed(dir) {
  const it = dnd.item;
  if (!it) return false;
  if (it.kind === 'request') return it.path.slice(0, it.path.lastIndexOf('/')) !== dir;
  return dir !== it.path && !dir.startsWith(it.path + '/') && it.path.slice(0, it.path.lastIndexOf('/')) !== dir;
}

export function dragOver(e, dir) {
  if (!allowed(dir)) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  dnd.target = dir;
}

export function dragLeave(e, dir) {
  if (dnd.target === dir && !e.currentTarget.contains(e.relatedTarget)) dnd.target = null;
}

export async function drop(e, dir) {
  if (!allowed(dir)) return;
  e.preventDefault();
  e.stopPropagation();
  const it = dnd.item;
  dragEnd();
  if (it.kind === 'request') await moveRequest(it.path, dir);
  else await moveFolderInto(it.path, dir);
}
