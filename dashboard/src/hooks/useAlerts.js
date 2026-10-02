import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

// Giữ tối đa bấy nhiêu cảnh báo trong bộ nhớ trình duyệt. Thống kê tổng thì
// lấy từ server (đếm trên cả bảng), không đếm từ danh sách này.
const MAX_KEPT = 1000;

export function useAlerts({ onNewAlerts } = {}) {
  const [alerts, setAlerts] = useState([]);
  const [stats, setStats] = useState(null);
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState({ db: 'connecting' });
  const [socketUp, setSocketUp] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const socketRef = useRef(null);
  // Tập id đã có, giữ ngoài state để lọc trùng ngay khi sự kiện tới (updater
  // của setState trong React 18 có thể chạy muộn hơn, không dựa vào được).
  const knownIds = useRef(new Set());
  const onNewRef = useRef(onNewAlerts);
  onNewRef.current = onNewAlerts;

  useEffect(() => {
    const socket = io({ transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => setSocketUp(true));
    socket.on('disconnect', () => setSocketUp(false));

    socket.on('snapshot', (snap) => {
      const list = snap.alerts ?? [];
      knownIds.current = new Set(list.map((a) => a.id));
      setAlerts(list);
      setStats(snap.stats ?? null);
      setSettings(snap.settings ?? null);
      setStatus(snap.status ?? { db: 'up' });
      setLoaded(true);
    });

    socket.on('alerts', (rows) => {
      // Lúc mới kết nối, một cảnh báo có thể đến hai lần: trong snapshot và
      // trong lượt poll ngay sau đó. Gộp theo id để không hiện trùng.
      const fresh = rows.filter((a) => !knownIds.current.has(a.id));
      if (!fresh.length) return;
      fresh.forEach((a) => knownIds.current.add(a.id));
      setAlerts((cur) => [...fresh].reverse().concat(cur).slice(0, MAX_KEPT));
      onNewRef.current?.(fresh);
    });

    socket.on('stats', setStats);
    socket.on('status', setStatus);
    // Bảng bị làm lại (reset.sh): id đánh số lại từ đầu, xin snapshot mới.
    socket.on('reset', () => socket.emit('refresh'));

    return () => socket.disconnect();
  }, []);

  const refresh = useCallback(() => socketRef.current?.emit('refresh'), []);

  const connection = !socketUp
    ? 'offline'
    : status.db === 'up' ? 'live' : status.db === 'down' ? 'db-down' : 'connecting';

  return { alerts, stats, settings, status, connection, loaded, refresh };
}
