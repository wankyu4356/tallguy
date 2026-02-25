import { useState, useEffect, useCallback } from 'react';
import Dashboard from './Dashboard';
import { parseWorkbook } from './parseExcel';

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [fileName, setFileName] = useState('');

  const loadFromUrl = useCallback(async (url) => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const parsed = parseWorkbook(buf);
      setData(parsed);
      setFileName('dashboard_data.xlsx');
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const loadFromFile = useCallback((file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = parseWorkbook(e.target.result);
        setData(parsed);
        setFileName(file.name);
        setError(null);
      } catch (err) {
        setError(err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  useEffect(() => {
    loadFromUrl('/data/dashboard_data.xlsx');
  }, [loadFromUrl]);

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer?.files[0];
    if (file && (file.name.endsWith('.xlsx') || file.name.endsWith('.xls'))) {
      loadFromFile(file);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  if (error && !data) {
    return (
      <div style={{
        minHeight: '100vh', background: '#0c0c14', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: "'Pretendard', -apple-system, sans-serif",
      }}>
        <div style={{ textAlign: 'center', maxWidth: 500 }}>
          <div style={{ fontSize: 48, marginBottom: 20 }}>📊</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>엑셀 파일을 불러와주세요</div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', marginBottom: 24, lineHeight: 1.6 }}>
            public/data/dashboard_data.xlsx 파일을 찾을 수 없습니다.<br />
            <code style={{ background: 'rgba(255,255,255,0.06)', padding: '2px 8px', borderRadius: 4 }}>
              npm run generate-excel
            </code> 명령으로 생성하거나,<br />
            아래에 엑셀 파일을 드래그 앤 드롭 해주세요.
          </div>
          <div
            onDrop={handleDrop} onDragOver={handleDragOver}
            style={{
              padding: '40px 20px', border: '2px dashed rgba(255,220,60,0.3)',
              borderRadius: 16, background: 'rgba(255,220,60,0.03)',
              cursor: 'pointer', transition: 'all 0.2s',
            }}
          >
            <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)' }}>
              📂 엑셀 파일(.xlsx)을 여기에 드롭
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div onDrop={handleDrop} onDragOver={handleDragOver}>
      <Dashboard
        data={data}
        fileName={fileName}
        onReload={() => loadFromUrl('/data/dashboard_data.xlsx')}
        onFileSelect={loadFromFile}
      />
    </div>
  );
}
