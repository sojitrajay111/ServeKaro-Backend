let io = null;

export const setIo = (server) => { io = server; };

export const rooms = {
  outlet: (id) => `outlet:${id}`,
  station: (id) => `station:${id}`,
  order: (id) => `order:${id}`,
  menu: (outletId) => `menu:${outletId}`,
};

// emit(['outlet:..', 'order:..'], 'order.updated', payload)
export function emit(roomList, event, payload) {
  if (!io) return;
  const list = (Array.isArray(roomList) ? roomList : [roomList]).filter(Boolean);
  if (list.length) io.to(list).emit(event, payload);
}
