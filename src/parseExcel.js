import * as XLSX from 'xlsx';

function parseMetricsSheet(ws) {
  const data = XLSX.utils.sheet_to_json(ws);
  return data.map(row => ({
    label: String(row['항목'] || ''),
    today: Number(row['금일']) || 0,
    yesterday: Number(row['전일']) || 0,
    lastWeek: Number(row['전주동일']) || 0,
    lastMonth: Number(row['전월동일']) || 0,
    lastYear: Number(row['전년동일']) || 0,
    unit: String(row['단위'] || ''),
    subLabel: String(row['부가라벨'] || ''),
    subValue: String(row['부가값'] || ''),
    displayFormat: String(row['표시형식'] || 'number'),
  }));
}

function parseTrendSheet(ws) {
  const data = XLSX.utils.sheet_to_json(ws);
  if (!data.length) return null;
  const dates = data.map(row => String(row['날짜']));
  const columns = Object.keys(data[0]).filter(k => k !== '날짜');
  const series = {};
  columns.forEach(col => {
    series[col] = data.map(row => Number(row[col]) || 0);
  });
  return { dates, series };
}

export function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'array' });
  const result = {
    settings: {},
    가입: [],
    이용: [],
    해지: [],
    가입_추이: null,
    해지_추이: null,
  };

  if (wb.SheetNames.includes('설정')) {
    const data = XLSX.utils.sheet_to_json(wb.Sheets['설정']);
    data.forEach(row => { result.settings[String(row['항목'])] = row['값']; });
  }

  ['가입', '이용', '해지'].forEach(name => {
    if (wb.SheetNames.includes(name)) {
      result[name] = parseMetricsSheet(wb.Sheets[name]);
    }
  });

  ['가입_추이', '해지_추이'].forEach(name => {
    if (wb.SheetNames.includes(name)) {
      result[name] = parseTrendSheet(wb.Sheets[name]);
    }
  });

  return result;
}
