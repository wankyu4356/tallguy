import XLSX from 'xlsx';
import * as fs from 'fs';

const wb = XLSX.utils.book_new();

/* ═══ 가입 (Registration) ═══ */
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['항목', '금일', '전일', '전주동일', '전월동일', '전년동일', '단위', '부가라벨', '부가값', '표시형식'],
  ['신규 가입자 수', 11847, 12105, 10921, 12105, 9834, '명', '당일 순증 고객', '11,024 명', 'number'],
  ['신규 가입 좌수', 15231, 14876, 14102, 15520, 12645, '좌', '1인 평균 좌수', '1.29 좌', 'number'],
]), '가입');

/* ═══ 이용 (Usage) ═══ */
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['항목', '금일', '전일', '전주동일', '전월동일', '전년동일', '단위', '부가라벨', '부가값', '표시형식'],
  ['전체 고객 수', 8423156, 8411309, 8340102, 8067231, 6892345, '명', '당일 기준', '', 'number'],
  ['활성 고객 수', 6575854, 6567788, 6510234, 6302102, 5421032, '명', '활성고객 비율', '78.1%', 'number'],
  ['0원 고객 수', 1847302, 1843521, 1829868, 1765129, 1471313, '명', '전체 대비 비율', '21.9%', 'number'],
  ['전체 계좌 수', 10234567, 10220336, 10135102, 9821345, 8102300, '좌', '', '', 'number'],
  ['활성 계좌 수', 7777778, 7768228, 7702345, 7451102, 6234560, '좌', '활성계좌 비율', '76.0%', 'number'],
  ['0원 계좌 수', 2456789, 2452108, 2432757, 2370243, 1867740, '좌', '전체 대비', '24.0%', 'number'],
  ['한도계좌 수', 345678, 345234, 343102, 335678, 278345, '좌', '전체 대비', '3.4%', 'number'],
  ['수신고 잔액', 12.47, 12.44, 12.21, 11.82, 9.45, '조', '입출금통장 수신고 전체 잔액', '계좌 + 세박 총 잔액 기준', 'money_cho'],
  ['고객 당 평잔', 1480234, 1477891, 1465102, 1432345, 1234567, '원', '전체 고객 기준', '', 'money'],
  ['계좌 당 평잔', 1218567, 1216234, 1205102, 1178345, 1023456, '원', '전체 계좌 기준', '', 'money'],
]), '이용');

/* ═══ 해지 (Churn) ═══ */
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['항목', '금일', '전일', '전주동일', '전월동일', '전년동일', '단위', '부가라벨', '부가값', '표시형식'],
  ['해지 고객 수', 823, 798, 756, 891, 1045, '명', '전체 가입자 대비', '0.0098%', 'number'],
  ['해지 계좌 수', 956, 921, 878, 1034, 1198, '좌', '전체 계좌 대비', '0.0093%', 'number'],
]), '해지');

/* ═══ Trend data generator ═══ */
function genLine(n, base, variance, seed) {
  const r = (s) => { let x = Math.sin(s) * 10000; return x - Math.floor(x); };
  return Array.from({ length: n }, (_, i) => {
    const dip = (i % 7 >= 5) ? -variance * 0.3 : 0;
    return Math.round(base + dip + (r(seed + i * 13.7) - 0.5) * variance + Math.sin(i / 5.5) * variance * 0.25);
  });
}

const n = 30;
const dates = Array.from({ length: n }, (_, i) => `${Math.floor(i / 31) + 1}/${(i % 31) + 1}`);

/* ═══ 가입_추이 (Registration Trend) ═══ */
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['날짜', '전체', '10대', '20대', '30대', '40대', '50대+', '남성', '여성'],
  ...dates.map((d, i) => [
    d,
    genLine(n, 12000, 2800, 42)[i],
    genLine(n, 3500, 800, 100)[i],
    genLine(n, 3100, 720, 137)[i],
    genLine(n, 2700, 640, 174)[i],
    genLine(n, 2300, 560, 211)[i],
    genLine(n, 1900, 480, 248)[i],
    genLine(n, 6200, 1400, 200)[i],
    genLine(n, 5700, 1400, 253)[i],
  ]),
]), '가입_추이');

/* ═══ 해지_추이 (Churn Trend) ═══ */
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['날짜', '전체', '10대', '20대', '30대', '40대', '50대+', '남성', '여성'],
  ...dates.map((d, i) => [
    d,
    genLine(n, 800, 200, 55)[i],
    genLine(n, 200, 60, 110)[i],
    genLine(n, 180, 50, 147)[i],
    genLine(n, 160, 45, 184)[i],
    genLine(n, 140, 40, 221)[i],
    genLine(n, 120, 35, 258)[i],
    genLine(n, 420, 120, 210)[i],
    genLine(n, 380, 100, 263)[i],
  ]),
]), '해지_추이');

/* ═══ 설정 (Settings) ═══ */
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['항목', '값'],
  ['기준일', '2026. 02. 25.'],
]), '설정');

/* ═══ Write file ═══ */
fs.mkdirSync('public/data', { recursive: true });
XLSX.writeFile(wb, 'public/data/dashboard_data.xlsx');
console.log('Mock Excel file generated: public/data/dashboard_data.xlsx');
