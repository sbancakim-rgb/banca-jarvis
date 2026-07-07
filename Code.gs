// === 설정 ===
var CLAUDE_API_KEY = 'YOUR_CLAUDE_API_KEY_HERE'; // Apps Script 편집기 좌측 "프로젝트 설정 > 스크립트 속성"에 넣어도 됨
var SHEET_SELLER = '판매자정보';
var SHEET_PROPOSAL = '제안서요청';
var SHEET_LOG = '방문로그';
var SHEET_USERS = '사용자목록';
var SHEET_DELETED = '삭제된 판매자';
var SHEET_TASKS = '업무리스트';
var SHEET_TASKS_DONE = '완료된업무';
var DATA_SPREADSHEET_ID = '1z1XB9HUxc8AtvDPXPRnzljLnXR05FJtz1Y3ChfW2iq4'; // 시스템 데이터 전용 스프레드시트("방카 활동의 기록 (시스템 데이터)")

// 실제 데이터가 저장된 스프레드시트. 이 스크립트 파일 자체는 기존 "은행분석 및 방문정리" 파일에 묶여있지만,
// 데이터는 별도 파일로 분리되어 있으므로 getActiveSpreadsheet() 대신 이 함수를 사용한다.
function getSS() {
  return SpreadsheetApp.openById(DATA_SPREADSHEET_ID);
}

function doGet(e) {
  var action = e.parameter.action;
  var text = e.parameter.text || '';
  var callback = e.parameter.callback;

  var result;
  try {
    if (action === 'record') {
      result = handleParse(text); // 음성을 항목별로 구조화만 함. 시트에는 아직 안 씀.
    } else if (action === 'reparse') {
      result = handleReparse(e.parameter.original || '', e.parameter.correction || '');
    } else if (action === 'commit') {
      result = handleCommit(JSON.parse(e.parameter.data)); // 사용자가 검토/수정한 내용을 최종 저장
    } else if (action === 'query') {
      result = handleQuery(text);
    } else if (action === 'queryByBranch') {
      result = handleQueryByBranch(e.parameter.bank || '', e.parameter.branch || '', e.parameter.seller || '');
    } else if (action === 'listBranches') {
      result = handleListBranches();
    } else if (action === 'listSellers') {
      result = handleListSellers(e.parameter.bank || '', e.parameter.branch || '');
    } else if (action === 'recordForSeller') {
      result = handleRecordForSeller(e.parameter.bank || '', e.parameter.branch || '', e.parameter.seller || '', e.parameter.text || '', e.parameter.date || '');
    } else if (action === 'logVisit') {
      result = handleLogVisit(e.parameter.bank || '', e.parameter.branch || '', e.parameter.date || '', e.parameter.visitType || '');
    } else if (action === 'getSellerInfo') {
      result = handleGetSellerInfo(e.parameter.bank || '', e.parameter.branch || '', e.parameter.seller || '');
    } else if (action === 'saveSellerFields') {
      result = handleSaveSellerFields(JSON.parse(e.parameter.data));
    } else if (action === 'calendarDay') {
      result = handleCalendarDay(e.parameter.date || '');
    } else if (action === 'listProposals') {
      result = handleListProposals();
    } else if (action === 'updateProposal') {
      result = handleUpdateProposal(Number(e.parameter.rowIndex), JSON.parse(e.parameter.data));
    } else if (action === 'updateSellerTitle') {
      result = handleUpdateSellerTitle(e.parameter.bank || '', e.parameter.branch || '', e.parameter.seller || '', e.parameter.newTitle || '');
    } else if (action === 'updateSellerName') {
      result = handleUpdateSellerName(e.parameter.bank || '', e.parameter.branch || '', e.parameter.seller || '', e.parameter.newName || '');
    } else if (action === 'findArchivedSellers') {
      result = handleFindArchivedSellers(e.parameter.bank || '', e.parameter.seller || '', e.parameter.title || '');
    } else if (action === 'getMe') {
      result = handleGetMe();
    } else if (action === 'listTasks') {
      result = handleListTasks();
    } else if (action === 'addTask') {
      result = handleAddTask(JSON.parse(e.parameter.data));
    } else if (action === 'editTask') {
      result = handleEditTask(e.parameter.id || '', JSON.parse(e.parameter.data));
    } else if (action === 'completeTask') {
      result = handleCompleteTask(e.parameter.id || '');
    } else if (action === 'moveTask') {
      result = handleMoveTask(e.parameter.id || '', e.parameter.direction || '');
    } else if (action === 'setTaskAlarm') {
      result = handleSetTaskAlarm(e.parameter.id || '', e.parameter.alarm || '');
    } else if (action === 'listCompletedTasks') {
      result = handleListCompletedTasks();
    } else if (action === 'dashboard') {
      result = handleDashboard();
    } else if (action === 'dashboardBank') {
      result = handleDashboardBank(e.parameter.bank || '');
    } else {
      result = { error: 'unknown action' };
    }
  } catch (err) {
    result = { error: err.message };
  }

  var body = callback ? callback + '(' + JSON.stringify(result) + ')' : JSON.stringify(result);
  return ContentService.createTextOutput(body)
    .setMimeType(callback ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}

var KOREAN_DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
var KOREAN_DIGIT_MAP = { '영': '0', '일': '1', '이': '2', '삼': '3', '사': '4', '오': '5', '육': '6', '칠': '7', '팔': '8', '구': '9' };

function formatDateWithDay(date) {
  var base = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return base + '(' + KOREAN_DAY_NAMES[date.getDay()] + ')';
}

// UI에서 "yyyy-MM-dd" 형식으로 넘어온 날짜를 라벨로 변환한다. 비어있거나 형식이 잘못되면 오늘 날짜를 쓴다.
// 지난 날짜로 방문 기록을 남길 때 쓰인다 (정보 기록 카드의 날짜 선택).
function resolveDateLabel(dateStr) {
  var s = String(dateStr || '').trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!isNaN(d.getTime())) return formatDateWithDay(d);
  }
  return formatDateWithDay(new Date());
}

// 은행명/지점명 음성인식 오류 보정: 띄어쓰기 제거 + 한글 숫자(구,육 등)와 아라비아 숫자를 동일하게 취급
function normalizeText(name) {
  var s = String(name || '').replace(/\s+/g, '');
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    out += KOREAN_DIGIT_MAP[ch] || ch;
  }
  return out;
}

function levenshtein(a, b) {
  a = a || ''; b = b || '';
  var dp = [];
  for (var i = 0; i <= a.length; i++) dp.push([i]);
  for (var j = 0; j <= b.length; j++) dp[0][j] = j;
  for (i = 1; i <= a.length; i++) {
    for (j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function similarity(a, b) {
  a = a || ''; b = b || '';
  if (!a.length && !b.length) return 1;
  var dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length, 1);
}

// 은행명/지점명 셀을 병합해두면, 병합된 아래쪽 행은 빈 칸으로 읽힌다.
// 바로 위 행의 값을 그대로 이어받은 것으로 간주해서 채워준다.
function fillMergedColumn(rows, colIndex) {
  var filled = [];
  var last = '';
  for (var i = 0; i < rows.length; i++) {
    var v = String(rows[i][colIndex] || '');
    if (v) last = v;
    filled.push(i === 0 ? v : last);
  }
  return filled;
}

// 일부만 말해도(부분 일치) 같은 곳으로 인식한다 ("구월동" -> "구월동종합금융센터")
function textMatches(storedNorm, spokenNorm) {
  if (!storedNorm || !spokenNorm) return false;
  return storedNorm === spokenNorm ||
    storedNorm.indexOf(spokenNorm) !== -1 ||
    spokenNorm.indexOf(storedNorm) !== -1;
}

// 같은 은행 내에 이미 등록된 지점명 중, 말한 지점명(부분 발화/오인식 포함)과 가장 비슷한 풀네임을 찾는다.
// 일치하는 후보가 없으면(완전히 새 지점) 말한 그대로를 돌려준다. 은행명은 사용자가 말한 대로 고정(임의 보정 안 함).
function resolveBranchName(rows, bankName, spokenBranch) {
  var normBank = normalizeText(bankName);
  var normSpoken = normalizeText(spokenBranch);
  var fallback = String(spokenBranch || '').trim();
  if (!normBank || !normSpoken) return fallback;

  var bankCol = fillMergedColumn(rows, 1);
  var branchCol = fillMergedColumn(rows, 2);
  var candidates = {}; // normBranch -> 풀네임
  for (var i = 1; i < rows.length; i++) {
    if (!textMatches(normalizeText(bankCol[i]), normBank)) continue;
    var full = String(branchCol[i] || '').trim();
    if (full) candidates[normalizeText(full)] = full;
  }

  var bestFull = null;
  var bestScore = -1;
  Object.keys(candidates).forEach(function (normFull) {
    var score;
    if (normFull === normSpoken) score = 1;
    else if (normFull.indexOf(normSpoken) !== -1 || normSpoken.indexOf(normFull) !== -1) score = 0.9;
    else score = similarity(normFull, normSpoken);
    if (score > bestScore) {
      bestScore = score;
      bestFull = candidates[normFull];
    }
  });

  return bestScore >= 0.55 ? bestFull : fallback;
}

// 은행명+지점명이 모두 일치하는 행만 같은 그룹으로 취급한다 (은행이 다르면 절대 같은 지점으로 보지 않음).
// 지점명은 resolveBranchName으로 먼저 풀네임을 확정한 뒤, 그 풀네임과 정확히 일치하는 행만 묶는다.
function findMatchingGroup(rows, bankName, branchName) {
  var normBank = normalizeText(bankName);
  if (!normBank || !String(branchName || '').trim()) return []; // 은행/지점 중 하나라도 비어있으면 매칭하지 않음 (임의 추측 금지)

  var canonicalBranch = resolveBranchName(rows, bankName, branchName);
  var normBranch = normalizeText(canonicalBranch);

  var bankCol = fillMergedColumn(rows, 1);
  var branchCol = fillMergedColumn(rows, 2);
  var group = [];
  for (var i = 1; i < rows.length; i++) {
    if (textMatches(normalizeText(bankCol[i]), normBank) && normalizeText(branchCol[i]) === normBranch) {
      group.push(i);
    }
  }
  return group;
}

// 정확히 같거나, 한쪽이 다른 쪽을 포함하면("세진" ⊂ "박세진") 높은 점수를 주고, 그 외엔 유사도로 채점한다.
function fuzzyNameScore(stored, spoken) {
  var s = normalizeText(stored);
  var p = normalizeText(spoken);
  if (!s || !p) return 0;
  if (s === p) return 1;
  if (s.indexOf(p) !== -1 || p.indexOf(s) !== -1) return 0.9;
  return similarity(s, p);
}

// 같은 은행+지점 그룹 내에서, 음성 인식이 부정확해도(성을 빼고 부르는 등) 가장 그럴듯한 기존 판매자 행을 찾는다.
// 판매자명을 말하지 않았으면(은행+지점만 언급) 그 그룹의 대표 행을 돌려준다 (날짜만 기록하는 용도).
// 은행/지점이 비어있거나 그룹 자체가 없으면 -1 (새 행 추가 대상).
function findBestSellerRow(rows, bankName, branchName, sellerName, position) {
  var group = findMatchingGroup(rows, bankName, branchName);
  if (group.length === 0) return -1;
  if (!String(sellerName || '').trim()) return group[0];

  var bestIndex = group[0];
  var bestScore = -1;
  group.forEach(function (idx) {
    var row = rows[idx];
    var nameScore = fuzzyNameScore(row[3], sellerName);
    var posScore = position && row[4] ? fuzzyNameScore(row[4], position) : 0;
    var score = nameScore * 0.85 + posScore * 0.15;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = idx;
    }
  });
  return bestIndex;
}

// 기존 내용 뒤에 새 내용을 줄바꿈으로 이어붙인다 (새로 말한 내용이 기존 내용을 지우지 않도록).
// 이미 같은 내용이 포함되어 있으면 중복으로 추가하지 않는다.
function appendField(existingVal, newVal) {
  var ev = String(existingVal || '').trim();
  var nv = String(newVal || '').trim();
  if (!nv) return ev;
  if (!ev) return nv;
  if (ev.indexOf(nv) !== -1) return ev;
  return ev + '\n' + nv;
}

// 가족관계/자택/판매성향/방문이력/기타대화내용을 합쳐서 "특이사항 없음" 수준인지 판단한다.
// 트리비얼하면 날짜만 기록하고 기존 내용을 덮어쓰지 않는다.
// entry.__manual이 true면(드롭다운+텍스트로 직접 입력한 경우) 짧아도 트리비얼로 취급하지 않는다 - "10글자 미만" 기준은
// 음성으로 "특이사항 없음"류를 말했을 때만 걸리도록 만든 것인데, 직접 타이핑한 짧은 메모까지 날려버리면 안 된다.
function isTrivialContent(entry) {
  var combined = ['가족관계', '자택', '판매성향', '방문이력', '기타대화내용'].map(function (k) {
    return String(entry[k] || '').trim();
  }).join('');
  var normalized = combined.replace(/\s+/g, '');
  if (!normalized) return true;
  var trivialPhrases = ['특이사항없음', '특이사항없다', '특이사항없었음', '단순방문', '특별한내용없음', '없음', '별다른내용없음', '별일없음'];
  if (trivialPhrases.indexOf(normalized) !== -1) return true;
  if (entry.__manual) return false;
  return normalized.length < 10;
}

var ENTRIES_SCHEMA_TEXT = '{\n' +
  '  "entries": [\n' +
  '    {\n' +
  '      "은행명": "", "지점명": "", "판매자명": "", "직책": "", "가족관계": "", "자택": "", ' +
  '"판매성향": "", "방문이력": "", "기타대화내용": "",\n' +
  '      "proposal_request": { "있음": false, "상품명": "", "가입금액": "", "고객성명": "", "고객나이": "", "고객성별": "" }\n' +
  '    }\n' +
  '  ]\n' +
  '}';

// Claude 응답을 항상 entries 배열로 정규화 (구버전 단일 객체 응답에도 대응)
function normalizeEntries(data) {
  if (data && Array.isArray(data.entries)) return data.entries;
  if (data && data['은행명'] !== undefined) return [data];
  return [];
}

// 1단계: 음성 텍스트를 항목별로 구조화만 함 (시트에는 쓰지 않음, 사용자 검토용)
function handleParse(transcript) {
  var prompt = '다음은 보험사 방카슈랑스 영업담당자가 은행 지점 방문 후 음성으로 남긴 메모입니다. ' +
    '음성인식(STT)을 거친 텍스트이므로 띄어쓰기 오류, 발음이 비슷한 단어로의 오인식, 조사 누락/오류가 섞여 있을 수 있습니다. ' +
    '문맥상 가장 자연스러운 의미로 보정해서 해석하세요(예: "구체적"이 "구취적"처럼 들렸거나 은행/지점명이 일부 깨졌어도 가장 그럴듯한 의미로 받아들이세요). ' +
    '아래 JSON 스키마로만 추출해서 답하세요. "entries" 배열에는 언급된 은행/지점/판매자별로 항목을 하나씩 만드세요.\n' +
    '- 한 지점에 여러 명의 판매자가 언급되면, 각 판매자에게 해당하는 내용만 그 사람의 entry에 넣으세요. 한 사람 얘기를 다른 사람 entry에 절대 섞지 마세요.\n' +
    '- 판매자 이름이 성 없이 이름(또는 일부)만 불려도 들린 그대로 "판매자명"에 넣으세요 (예: "세진 팀장" -> 판매자명 "세진", 직책 "팀장"). 시스템이 나중에 기존 판매자와 매칭합니다.\n' +
    '- 여러 은행/지점이 동시에 언급되었지만 구체적인 대화 내용 없이 단순 방문/특이사항 없음 정도만 언급된 경우, 각 은행/지점마다 별도 entry를 만들고 판매자명과 나머지 항목은 모두 빈 문자열로 두세요.\n' +
    '- 해당 항목 정보가 없으면 빈 문자열로 두세요. 항목에 맞지 않는 추가 정보는 모두 "기타대화내용"에 합쳐서 넣으세요.\n' +
    '- 제안서 요청이 언급되면 해당 판매자 entry의 proposal_request를 채우세요(상품명, 가입금액, 고객성명/나이/성별 포함).\n' +
    '- 각 값에는 마크다운이나 기호(*, #, -, /, {, } 등) 없이 평문 텍스트만 넣으세요.\n\n' +
    '스키마:\n' + ENTRIES_SCHEMA_TEXT + '\n\n' +
    '메모: ' + transcript;

  var data = callClaude(prompt);
  return { ok: true, parsed: { entries: normalizeEntries(data) } };
}

// 녹음 종료 후 재확인 단계에서, 사용자가 음성으로 정정한 내용을 원래 메모에 반영해 다시 구조화
function handleReparse(original, correction) {
  var prompt = '다음은 보험사 방카슈랑스 영업담당자가 은행 지점 방문 후 음성으로 남긴 메모와, ' +
    '그 내용을 다시 들려준 뒤 사용자가 말한 정정/추가 사항입니다. 정정 사항을 반영해서 최종 내용을 같은 JSON 스키마(entries 배열)로 추출해 답하세요. ' +
    '정정 사항에서 언급되지 않은 entry나 항목은 원래 메모의 내용을 그대로 유지하세요. ' +
    '마크다운이나 기호(*, #, -, /, {, } 등) 없이 평문 텍스트만 넣으세요.\n\n' +
    '스키마:\n' + ENTRIES_SCHEMA_TEXT + '\n\n' +
    '원래 메모: ' + original + '\n\n' +
    '정정/추가 사항: ' + correction;

  var data = callClaude(prompt);
  return { ok: true, parsed: { entries: normalizeEntries(data) } };
}

// 2단계: 사용자가 음성으로 확인한 최종 내용(entries 배열, 판매자별/지점별로 분리됨)을 시트에 저장
function handleCommit(data) {
  var entries = normalizeEntries(data);
  if (entries.length === 0) {
    return { ok: false, message: '저장할 내용이 없습니다.' };
  }

  var sheet = getSS().getSheetByName(SHEET_SELLER);
  var logSheet = getSS().getSheetByName(SHEET_LOG);
  var pSheet = getSS().getSheetByName(SHEET_PROPOSAL);
  // 정보 기록 카드에서 날짜를 직접 선택했으면(지난 날짜 기록 등) 그 날짜를 쓰고, 없으면 오늘 날짜를 쓴다.
  var todayLabel = resolveDateLabel(data && data.date);
  var results = [];

  entries.forEach(function (entry) {
    var bank = String(entry['은행명'] || '').trim();
    var branchInput = String(entry['지점명'] || '').trim();
    if (!bank || !branchInput) {
      results.push({ 은행명: bank, 지점명: branchInput, error: '은행명/지점명이 명확하지 않아 건너뜀' });
      return;
    }

    // entry마다 다시 읽어서, 같은 commit 안에서 앞서 새로 생긴 행도 바로 매칭 대상에 포함시킨다.
    var rows = sheet.getDataRange().getValues();
    // 지점명은 부분 발화/오인식이어도 그 은행에 이미 등록된 지점 풀네임으로 먼저 확정한다 (예: "가좌공단" -> "가좌공단금융센터", "인천" vs "인천법조타운"을 서로 다른 지점으로 정확히 구분).
    var resolvedBranch = resolveBranchName(rows, bank, branchInput);
    var trivial = isTrivialContent(entry);
    var sellerWasSpecified = !!String(entry['판매자명'] || '').trim();
    // 판매자명은 성 없이 일부만 불러도("세진" -> "박세진") fuzzyNameScore로 매칭된다. 판매자명이 비었으면 그룹 대표 행(날짜만 기록용).
    var matchRowIndex = findBestSellerRow(rows, bank, resolvedBranch, entry['판매자명'], entry['직책']);

    var canonicalBank = bank;
    var canonicalBranch = resolvedBranch;
    // 사용자가 판매자명을 말하지 않았으면(은행+지점만 언급) 방문로그/달력에는 특정인 이름을 붙이지 않고 지점명만 남긴다.
    var canonicalSeller = sellerWasSpecified ? entry['판매자명'] : '';

    var userEmail = getCurrentUserEmail();
    if (matchRowIndex === -1) {
      sheet.appendRow([
        todayLabel, bank, resolvedBranch, entry['판매자명'], entry['직책'],
        trivial ? '' : entry['가족관계'], trivial ? '' : entry['자택'], trivial ? '' : entry['판매성향'],
        trivial ? '' : entry['방문이력'], trivial ? '' : entry['기타대화내용'], '', userEmail
      ]);
      sheet.getRange(sheet.getLastRow(), 1, 1, 12).setWrap(true);
    } else {
      var rowNum = matchRowIndex + 1; // 시트는 1-based
      var existing = rows[matchRowIndex];
      // 은행명/지점명은 음성 인식 오차로 잘못 덮어쓰면 안 되므로, 기존 시트의 정확한 값을 그대로 사용
      canonicalBank = existing[1];
      canonicalBranch = existing[2];
      // 판매자명을 말한 경우에만 기존 시트의 정확한 판매자명으로 교체 (말 안 했으면 위에서 정한 빈 값 유지)
      if (sellerWasSpecified) canonicalSeller = existing[3];

      // 날짜 칸이 지점 단위로 병합되어 있으면, 병합의 맨 위(앵커) 셀에 적어야 실제로 보인다.
      var dateCell = sheet.getRange(rowNum, 1);
      var mergedRanges = dateCell.getMergedRanges();
      var dateAnchorRange = mergedRanges.length > 0 ? mergedRanges[0] : dateCell;
      var existingDates = String(dateAnchorRange.getValue() || '').trim();
      var newDateField = existingDates.indexOf(todayLabel) !== -1
        ? existingDates
        : (existingDates ? existingDates + '\n' + todayLabel : todayLabel);
      dateAnchorRange.setValue(newDateField);

      // 특이사항 없음/단순방문/10글자 미만처럼 내용이 트리비얼하면 날짜만 찍고 기존 내용은 건드리지 않는다.
      // 트리비얼하지 않으면, 새로 말한 내용을 기존 내용을 지우지 않고 줄바꿈으로 이어붙인다.
      if (!trivial) {
        sheet.getRange(rowNum, 2, 1, 9).setValues([[
          existing[1],
          existing[2],
          existing[3],
          entry['직책'] || existing[4],
          appendField(existing[5], entry['가족관계']),
          appendField(existing[6], entry['자택']),
          appendField(existing[7], entry['판매성향']),
          appendField(existing[8], entry['방문이력']),
          appendField(existing[9], entry['기타대화내용'])
        ]]);
        sheet.getRange(rowNum, 1, 1, 10).setWrap(true);
      }
    }

    logSheet.appendRow([
      todayLabel, canonicalBank, canonicalBranch, canonicalSeller,
      trivial ? '' : (entry['방문이력'] || entry['기타대화내용']), userEmail
    ]);

    if (entry.proposal_request && entry.proposal_request['있음']) {
      pSheet.appendRow([
        todayLabel, canonicalBank, canonicalBranch, canonicalSeller,
        entry.proposal_request['상품명'], entry.proposal_request['가입금액'],
        entry.proposal_request['고객성명'], entry.proposal_request['고객나이'],
        entry.proposal_request['고객성별'], '대기'
      ]);
    }

    results.push({
      은행명: canonicalBank, 지점명: canonicalBranch, 판매자명: canonicalSeller,
      trivial: trivial,
      가족관계: trivial ? '' : entry['가족관계'], 자택: trivial ? '' : entry['자택'],
      판매성향: trivial ? '' : entry['판매성향'], 방문이력: trivial ? '' : entry['방문이력'],
      기타대화내용: trivial ? '' : entry['기타대화내용'],
      proposal_request: entry.proposal_request || null
    });
  });

  return { ok: true, results: results };
}

// 조회 음성에서 은행명/지점명/판매자명(선택)을 구조화
function parseQueryFields(transcript) {
  var prompt = '다음은 보험사 방카슈랑스 영업담당자가 방문 전 정보를 조회하려고 한 음성 질문입니다. ' +
    '음성인식(STT) 결과라 띄어쓰기나 발음이 비슷한 단어로의 오인식이 섞여 있을 수 있으니, 문맥상 가장 자연스러운 은행명/지점명/판매자명으로 보정해서 추출하세요. ' +
    '은행명, 지점명, 판매자명(언급 안 했으면 빈 문자열)을 아래 JSON으로만 추출하세요. ' +
    '기호 없이 평문으로만 넣으세요.\n\n' +
    '{ "은행명": "", "지점명": "", "판매자명": "" }\n\n' +
    '질문: ' + transcript;
  return callClaude(prompt);
}

function handleQuery(transcript) {
  var q = parseQueryFields(transcript);
  return buildBranchSummary(q['은행명'], q['지점명'], q['판매자명']);
}

// UI의 은행/지점(+판매자) 드롭다운으로 직접 선택했을 때 - 자연어 파싱 없이 바로 조회. 판매자를 선택 안 하면 지점 전체.
function handleQueryByBranch(bank, branch, seller) {
  return buildBranchSummary(bank, branch, seller || '');
}

function buildBranchSummary(qBank, qBranch, qSeller) {
  if (!String(qBank || '').trim() || !String(qBranch || '').trim()) {
    return {
      ok: true,
      summary: '은행명과 지점명을 정확히 말씀해주셔야 조회할 수 있습니다. 예를 들어 국민은행 구월동지점처럼 말씀해주세요.',
      needsClarification: true
    };
  }

  var sellerSheet = getSS().getSheetByName(SHEET_SELLER);
  var sellerRows = sellerSheet.getDataRange().getValues();
  var bankCol = fillMergedColumn(sellerRows, 1);
  var branchCol = fillMergedColumn(sellerRows, 2);

  // 지점명은 부분 발화/오인식이어도 그 은행에 이미 등록된 지점 풀네임으로 먼저 확정해서 찾는다.
  // (예: "인천"이라고 하면 "인천"만, "인천 법조타운"이라고 하면 "인천법조타운"만 - 풀네임 확정 후엔 정확히 일치하는 것만 묶는다.)
  var resolvedBranch = resolveBranchName(sellerRows, qBank, qBranch);
  var normBank = normalizeText(qBank);
  var normBranchSpoken = normalizeText(qBranch);
  var normBranch = normalizeText(resolvedBranch);

  var branchOnlyMatches = []; // 지점명만 헐겁게 일치 (은행 무관) - 같은/비슷한 지점명이 다른 은행에 있는지 확인용 힌트
  var fullMatches = []; // 은행 일치 + 지점명 풀네임 정확히 일치
  for (var i = 1; i < sellerRows.length; i++) {
    if (textMatches(normalizeText(branchCol[i]), normBranchSpoken)) branchOnlyMatches.push(i);
    if (textMatches(normalizeText(bankCol[i]), normBank) && normalizeText(branchCol[i]) === normBranch) {
      fullMatches.push(i);
    }
  }

  if (fullMatches.length === 0) {
    if (branchOnlyMatches.length > 0) {
      var otherBanks = [...new Set(branchOnlyMatches.map(function (idx) { return String(bankCol[idx]); }))];
      return {
        ok: true,
        needsClarification: true,
        summary: qBranch + '은 ' + otherBanks.join(', ') + '에 있습니다. 어느 은행인지 다시 한번 정확히 말씀해주세요.'
      };
    }
    return { ok: true, summary: qBank + ' ' + qBranch + '에 대한 기록이 아직 없습니다.' };
  }

  // 판매자명까지 말한 경우, 그 그룹 안에서 해당 판매자만 추려낸다. 불명확하면 추측하지 않고 다시 물어본다.
  var targetRows = fullMatches;
  if (String(qSeller || '').trim()) {
    var sellerHits = fullMatches.filter(function (idx) {
      var name = String(sellerRows[idx][3] || '');
      return name.indexOf(qSeller) !== -1 || qSeller.indexOf(name) !== -1 || similarity(name, qSeller) >= 0.6;
    });
    if (sellerHits.length === 0) {
      return {
        ok: true,
        needsClarification: true,
        summary: qBank + ' ' + qBranch + '에서 ' + qSeller + ' 판매자를 찾을 수 없습니다. 이름을 다시 한번 말씀해주세요.'
      };
    }
    targetRows = sellerHits;
  }

  var matchedSellers = targetRows.map(function (idx) { return sellerRows[idx]; });

  // 화면에 이름/직책/저장된 정보는 굵게, 정보 없는 항목은 옅게 표시하기 위한 구조화 데이터 (시트 원본 값 그대로)
  var sellersStructured = matchedSellers.map(function (r) {
    return {
      판매자명: r[3], 직책: r[4], 가족관계: r[5], 자택: r[6],
      판매성향: r[7], 방문이력: r[8], 기타대화내용: r[9]
    };
  });

  // 음성으로 읽어주는 내용과 화면에 보이는 텍스트가 항상 똑같도록, 같은 구조화 데이터를 그대로 문장으로 풀어서 사용한다 (Claude 가공 없음).
  var summary = sanitizeText(buildSpokenSellerSummary(sellersStructured));

  return { ok: true, summary: summary, sellers: sellersStructured };
}

// renderSellerInfo(프론트엔드)가 화면에 표시하는 항목과 정확히 같은 순서/내용으로 음성용 문장을 만든다.
function buildSpokenSellerSummary(sellersStructured) {
  var fieldDefs = [
    ['가족관계', '가족관계'], ['자택', '자택'], ['판매성향', '판매성향'],
    ['방문이력', '방문이력'], ['기타대화내용', '기타']
  ];
  return sellersStructured.map(function (s) {
    var lead = [String(s.판매자명 || '').trim(), String(s.직책 || '').trim()].filter(Boolean).join(' ');
    var lines = fieldDefs.map(function (fd) {
      var key = fd[0], label = fd[1];
      var v = String(s[key] || '').trim();
      return label + '은 ' + (v ? v : '정보 없음');
    });
    return (lead ? lead + '. ' : '') + lines.join('. ') + '.';
  }).join(' ');
}

// 지점 조회 카드의 은행/지점 드롭다운을 채우기 위한, 시트에 등록된 모든 은행+지점 목록(중복 제거)
// 담당자 이메일이 설정된 행은 본인 것만, 미설정 행은 모두에게 표시(마이그레이션 호환)
function handleListBranches() {
  var email = getCurrentUserEmail().toLowerCase();
  var sheet = getSS().getSheetByName(SHEET_SELLER);
  var rows = sheet.getDataRange().getValues();
  var bankCol = fillMergedColumn(rows, 1);
  var branchCol = fillMergedColumn(rows, 2);

  var seen = {};
  var branches = [];
  for (var i = 1; i < rows.length; i++) {
    var rowEmail = String(rows[i][11] || '').trim().toLowerCase();
    if (email && rowEmail && rowEmail !== email) continue;
    var bank = String(bankCol[i] || '').trim();
    var branch = String(branchCol[i] || '').trim();
    if (!bank || !branch) continue;
    var key = normalizeText(bank) + '|' + normalizeText(branch);
    if (seen[key]) continue;
    seen[key] = true;
    branches.push({ 은행명: bank, 지점명: branch });
  }

  branches.sort(function (a, b) {
    if (a.은행명 !== b.은행명) return a.은행명.localeCompare(b.은행명, 'ko');
    return a.지점명.localeCompare(b.지점명, 'ko');
  });

  return { ok: true, branches: branches };
}

// 은행+지점을 선택했을 때, 그 지점에 등록된 판매자 목록(드롭다운용)
function handleListSellers(bank, branch) {
  var email = getCurrentUserEmail().toLowerCase();
  var sheet = getSS().getSheetByName(SHEET_SELLER);
  var rows = sheet.getDataRange().getValues();
  var group = findMatchingGroup(rows, bank, branch);
  if (email) {
    group = group.filter(function (idx) {
      var rowEmail = String(rows[idx][11] || '').trim().toLowerCase();
      return !rowEmail || rowEmail === email;
    });
  }
  var sellers = group.map(function (idx) {
    return { 판매자명: String(rows[idx][3] || '').trim(), 직책: String(rows[idx][4] || '').trim() };
  }).filter(function (s) { return s.판매자명; });
  return { ok: true, sellers: sellers };
}

// 은행/지점/판매자를 드롭다운으로 선택하고 자유롭게 나열한 메모를, 정해진 5개 항목(+제안서 요청)으로 분류한다.
function classifyNoteText(text) {
  var prompt = '다음은 보험사 방카슈랑스 영업담당자가 특정 판매자에 대해 나열식으로 자유롭게 적은 메모입니다. ' +
    '아래 JSON 스키마의 항목에 맞게 내용을 분류해서 답하세요. 해당 항목 정보가 없으면 빈 문자열로 두세요. ' +
    '항목에 맞지 않는 내용은 모두 "기타대화내용"에 합쳐서 넣으세요. ' +
    '제안서 요청이 언급되면 proposal_request를 채우세요(상품명, 가입금액, 고객성명/나이/성별 포함). ' +
    '각 값에는 마크다운이나 기호(*, #, -, /, {, } 등) 없이 평문 텍스트만 넣으세요.\n\n' +
    '스키마:\n' +
    '{\n  "가족관계": "", "자택": "", "판매성향": "", "방문이력": "", "기타대화내용": "",\n' +
    '  "proposal_request": { "있음": false, "상품명": "", "가입금액": "", "고객성명": "", "고객나이": "", "고객성별": "" }\n}\n\n' +
    '메모: ' + text;
  return callClaude(prompt);
}

// 방문기록 카드에서 은행/지점/판매자를 드롭다운으로 선택하고 메모를 적어 저장하는 경우.
// 분류만 새로 하고, 실제 저장(누적/병합, 날짜 처리 등)은 handleCommit과 완전히 동일한 로직을 그대로 재사용한다.
function handleRecordForSeller(bank, branch, seller, text, date) {
  if (!String(bank || '').trim() || !String(branch || '').trim()) {
    return { ok: false, message: '은행과 지점을 선택해주세요.' };
  }
  if (!String(text || '').trim()) {
    return { ok: false, message: '입력할 내용이 없습니다.' };
  }
  var classified = classifyNoteText(text);
  var entry = {
    은행명: bank, 지점명: branch, 판매자명: seller || '', 직책: '',
    가족관계: classified['가족관계'] || '', 자택: classified['자택'] || '',
    판매성향: classified['판매성향'] || '', 방문이력: classified['방문이력'] || '',
    기타대화내용: classified['기타대화내용'] || '', proposal_request: classified.proposal_request || null,
    __manual: true
  };
  return handleCommit({ entries: [entry], date: date });
}

// 방문 지점 입력: 방문로그에만 기록 (판매자 정보 시트는 건드리지 않음)
function handleLogVisit(bank, branch, date, visitType) {
  if (!String(bank || '').trim() || !String(branch || '').trim()) {
    return { ok: false, message: '은행과 지점을 선택해주세요.' };
  }
  var email = getCurrentUserEmail();
  var sheet = getSS().getSheetByName(SHEET_SELLER);
  var rows = sheet.getDataRange().getValues();
  var resolvedBranch = resolveBranchName(rows, bank, branch);
  var dateLabel = resolveDateLabel(date);
  var logSheet = getSS().getSheetByName(SHEET_LOG);
  logSheet.appendRow([dateLabel, bank, resolvedBranch, '', '', email, String(visitType || '지점방문').trim()]);
  return { ok: true, dateLabel: dateLabel, bank: bank, branch: resolvedBranch };
}

// 판매자 드롭다운 선택 시 현재 저장된 정보를 로드해 필드를 채워주기 위한 조회
function handleGetSellerInfo(bank, branch, seller) {
  if (!String(seller || '').trim()) return { ok: true, seller: null };
  var email = getCurrentUserEmail().toLowerCase();
  var sheet = getSS().getSheetByName(SHEET_SELLER);
  var rows = sheet.getDataRange().getValues();
  var rowIdx = findBestSellerRow(rows, bank, branch, seller, '');
  if (rowIdx === -1) return { ok: true, seller: null };
  var rowEmail = String(rows[rowIdx][11] || '').trim().toLowerCase();
  if (email && rowEmail && rowEmail !== email) return { ok: true, seller: null };
  var r = rows[rowIdx];
  return {
    ok: true,
    seller: {
      판매자명: String(r[3] || '').trim(),
      직책:     String(r[4] || '').trim(),
      가족관계:  String(r[5] || '').trim(),
      자택:     String(r[6] || '').trim(),
      판매성향:  String(r[7] || '').trim(),
      방문이력:  String(r[8] || '').trim(),
      기타대화내용: String(r[9] || '').trim()
    }
  };
}

// 직책만 수정
function handleUpdateSellerTitle(bank, branch, seller, newTitle) {
  if (!bank || !branch || !seller) return { ok: false, message: '은행, 지점, 판매자를 모두 선택해주세요.' };
  var email = getCurrentUserEmail().toLowerCase();
  var sheet = getSS().getSheetByName(SHEET_SELLER);
  var rows = sheet.getDataRange().getValues();
  var rowIdx = findBestSellerRow(rows, bank, branch, seller, '');
  if (rowIdx === -1) return { ok: false, message: '판매자를 찾을 수 없습니다.' };
  var rowEmail = String(rows[rowIdx][11] || '').trim().toLowerCase();
  if (email && rowEmail && rowEmail !== email) return { ok: false, message: '다른 담당자의 판매자입니다.' };
  sheet.getRange(rowIdx + 1, 5, 1, 1).setValue(newTitle.trim());
  return { ok: true, newTitle: newTitle.trim() };
}

// 판매자 이름 교체: 기존 정보를 삭제된 판매자 시트로 보관 후, 현재 행은 새 이름으로 초기화
function handleUpdateSellerName(bank, branch, seller, newName) {
  if (!bank || !branch || !seller || !newName) return { ok: false, message: '필수 항목이 빠졌습니다.' };
  var newNameTrimmed = String(newName).trim();
  if (normalizeText(newNameTrimmed) === normalizeText(seller)) return { ok: false, message: '이름이 동일합니다.' };

  var email = getCurrentUserEmail().toLowerCase();
  var ss = getSS();
  var sheet = ss.getSheetByName(SHEET_SELLER);
  var rows = sheet.getDataRange().getValues();
  var rowIdx = findBestSellerRow(rows, bank, branch, seller, '');
  if (rowIdx === -1) return { ok: false, message: '판매자를 찾을 수 없습니다.' };
  var rowEmail = String(rows[rowIdx][11] || '').trim().toLowerCase();
  if (email && rowEmail && rowEmail !== email) return { ok: false, message: '다른 담당자의 판매자입니다.' };

  // 삭제된 판매자 시트에 기존 행 보관 (삭제일 추가)
  var delSheet = ss.getSheetByName(SHEET_DELETED);
  if (!delSheet) {
    delSheet = ss.insertSheet(SHEET_DELETED);
    delSheet.appendRow(['날짜', '은행명', '지점명', '판매자명', '직책', '가족관계', '자택', '판매성향', '방문이력', '기타대화내용', '영업대상', '담당자이메일', '삭제일']);
  }
  var oldRow = rows[rowIdx];
  delSheet.appendRow(oldRow.slice(0, 12).concat([Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')]));
  delSheet.getRange(delSheet.getLastRow(), 1, 1, 13).setWrap(true);

  // 현재 행: 새 이름으로 교체하고 개인정보 필드 초기화 (새 사람이므로)
  var rowNum = rowIdx + 1;
  sheet.getRange(rowNum, 4, 1, 7).setValues([[newNameTrimmed, '', '', '', '', '', '']]);

  return { ok: true, oldName: String(seller).trim(), newName: newNameTrimmed };
}

// 이전 담당자 정보 찾기: 은행+이름+직책 기준으로 삭제된 판매자 시트 및 다른 사용자의 판매자정보를 탐색
// 1건이면 자동 복원용, 2건 이상이면 후보 목록 반환
function handleFindArchivedSellers(bank, sellerName, title) {
  if (!bank || !sellerName || !title) return { ok: true, candidates: [] };
  var normBank = normalizeText(bank);
  var normName = normalizeText(sellerName);
  var normTitle = normalizeText(title);
  var myEmail = getCurrentUserEmail().toLowerCase();
  var ss = getSS();
  var candidates = [];

  function rowToCandidate(r, source) {
    return {
      source: source,
      지점명: String(r[2] || '').trim(),
      판매자명: String(r[3] || '').trim(),
      직책: String(r[4] || '').trim(),
      가족관계: String(r[5] || '').trim(),
      자택: String(r[6] || '').trim(),
      판매성향: String(r[7] || '').trim(),
      방문이력: String(r[8] || '').trim(),
      기타대화내용: String(r[9] || '').trim(),
      날짜: String(r[0] || '').trim()
    };
  }

  // 1) 삭제된 판매자 시트 탐색
  var delSheet = ss.getSheetByName(SHEET_DELETED);
  if (delSheet) {
    var delRows = delSheet.getDataRange().getValues();
    for (var i = 1; i < delRows.length; i++) {
      var r = delRows[i];
      if (normalizeText(String(r[1] || '')) !== normBank) continue;
      if (normalizeText(String(r[3] || '')) !== normName) continue;
      if (normalizeText(String(r[4] || '')) !== normTitle) continue;
      candidates.push(rowToCandidate(r, '보관'));
    }
  }

  // 2) 판매자정보 시트에서 다른 사용자 행 탐색
  var selSheet = ss.getSheetByName(SHEET_SELLER);
  var selRows = selSheet.getDataRange().getValues();
  for (var j = 1; j < selRows.length; j++) {
    var sr = selRows[j];
    var srEmail = String(sr[11] || '').trim().toLowerCase();
    if (srEmail && srEmail === myEmail) continue; // 내 데이터 제외
    if (normalizeText(String(sr[1] || '')) !== normBank) continue;
    if (normalizeText(String(sr[3] || '')) !== normName) continue;
    if (normalizeText(String(sr[4] || '')) !== normTitle) continue;
    candidates.push(rowToCandidate(sr, '현재'));
  }

  return { ok: true, candidates: candidates };
}

// 판매자 정보 폼에서 각 항목별로 입력한 내용을 저장 (프런트에서 전체 편집된 텍스트를 그대로 받아 덮어씀)
// 폼에 기존 내용이 이미 표시된 상태에서 사용자가 직접 수정하므로, appendField 대신 덮어쓰기
function handleSaveSellerFields(data) {
  var bank   = String(data.bank   || '').trim();
  var branch = String(data.branch || '').trim();
  var seller = String(data.seller || '').trim();
  if (!bank || !branch || !seller) {
    return { ok: false, message: '은행, 지점, 판매자를 모두 선택해주세요.' };
  }

  var sheet = getSS().getSheetByName(SHEET_SELLER);
  var logSheet = getSS().getSheetByName(SHEET_LOG);
  var rows = sheet.getDataRange().getValues();
  var todayLabel = resolveDateLabel(data.date);
  var resolvedBranch = resolveBranchName(rows, bank, branch);
  var rowIdx = findBestSellerRow(rows, bank, resolvedBranch, seller, '');

  var fam  = String(data['가족관계']    || '').trim();
  var home = String(data['자택']       || '').trim();
  var tend = String(data['판매성향']    || '').trim();
  var hist = String(data['방문이력']    || '').trim();
  var etc  = String(data['기타대화내용'] || '').trim();

  var email = getCurrentUserEmail();
  if (rowIdx === -1) {
    sheet.appendRow([todayLabel, bank, resolvedBranch, seller, '', fam, home, tend, hist, etc, '', email]);
    sheet.getRange(sheet.getLastRow(), 1, 1, 12).setWrap(true);
  } else {
    var existingEmail = String(rows[rowIdx][11] || '').trim().toLowerCase();
    if (existingEmail && email && existingEmail !== email.toLowerCase()) {
      return { ok: false, message: '다른 담당자의 판매자입니다.' };
    }
    var rowNum = rowIdx + 1;
    var existing = rows[rowIdx];
    var dateCell = sheet.getRange(rowNum, 1);
    var mergedRanges = dateCell.getMergedRanges();
    var dateAnchorRange = mergedRanges.length > 0 ? mergedRanges[0] : dateCell;
    var existingDates = String(dateAnchorRange.getValue() || '').trim();
    var newDateField = existingDates.indexOf(todayLabel) !== -1
      ? existingDates
      : (existingDates ? existingDates + '\n' + todayLabel : todayLabel);
    dateAnchorRange.setValue(newDateField);
    sheet.getRange(rowNum, 6, 1, 5).setValues([[fam, home, tend, hist, etc]]);
    if (!existingEmail && email) sheet.getRange(rowNum, 12, 1, 1).setValue(email);
    sheet.getRange(rowNum, 1, 1, 12).setWrap(true);
  }

  return { ok: true };
}

// 달력에서 특정 날짜(YYYY-MM-DD)를 누르면 그날 방문한 점포 목록을 보여줌
function handleCalendarDay(dateStr) {
  var email = getCurrentUserEmail().toLowerCase();
  var logSheet = getSS().getSheetByName(SHEET_LOG);
  var logRows = logSheet.getDataRange().getValues();
  var matches = logRows.slice(1).filter(function (r) {
    if (String(r[0] || '').indexOf(dateStr) !== 0) return false;
    var rowEmail = String(r[5] || '').trim().toLowerCase();
    return !email || !rowEmail || rowEmail === email;
  });

  // 판매자명 없이(은행+지점만) 기록된 줄은 같은 은행+지점이면 한 번만 보여준다 (중복 제거).
  var seenBranchOnly = {};
  var visits = [];
  matches.forEach(function (r) {
    var seller = String(r[3] || '').trim();
    var key = normalizeText(r[1]) + '|' + normalizeText(r[2]);
    if (!seller) {
      if (seenBranchOnly[key]) return;
      seenBranchOnly[key] = true;
    }
    visits.push({ 은행명: r[1], 지점명: r[2], 판매자명: seller, 방문이력: r[4], 방문유형: String(r[6] || '').trim() || '지점방문' });
  });

  var branchSet = {};
  var sellerSet = {};
  visits.forEach(function (v) {
    var bKey = normalizeText(v.은행명) + '|' + normalizeText(v.지점명);
    branchSet[bKey] = true;
    if (v.판매자명) sellerSet[bKey + '|' + normalizeText(v.판매자명)] = true;
  });

  return {
    ok: true,
    date: dateStr,
    branchCount: Object.keys(branchSet).length,
    sellerCount: Object.keys(sellerSet).length,
    visits: visits
  };
}

// 은행별: 모수(영업대상 지점수) / 당월 방문 지점수 / 미방문 지점수
// 판매자정보 시트 K열(영업대상, 체크박스)에 TRUE로 표시된 지점만 모수로 집계함
function handleDashboard() {
  var email = getCurrentUserEmail().toLowerCase();
  var sheet = getSS().getSheetByName(SHEET_SELLER);
  var rows = sheet.getDataRange().getValues();
  var bankCol = fillMergedColumn(rows, 1);
  var branchCol = fillMergedColumn(rows, 2);

  var targetBranchesByBank = {}; // bank -> Set(branchKey) 모수
  var allBranchLabelByKey = {};
  for (var i = 1; i < rows.length; i++) {
    var rowEmail = String(rows[i][11] || '').trim().toLowerCase();
    if (email && rowEmail && rowEmail !== email) continue;
    var bank = String(bankCol[i] || '').trim();
    var branch = String(branchCol[i] || '').trim();
    if (!bank || !branch) continue;
    var isTarget = rows[i][10] === true || String(rows[i][10] || '').toUpperCase() === 'TRUE';
    if (!isTarget) continue;
    var key = normalizeText(bank) + '|' + normalizeText(branch);
    if (!targetBranchesByBank[bank]) targetBranchesByBank[bank] = {};
    targetBranchesByBank[bank][key] = true;
    allBranchLabelByKey[key] = branch;
  }

  var thisMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  var logSheet = getSS().getSheetByName(SHEET_LOG);
  var logRows = logSheet.getDataRange().getValues();
  var visitedByBank = {}; // bank -> Set(branchKey) 이번달 방문
  for (var j = 1; j < logRows.length; j++) {
    var logDate = String(logRows[j][0] || '');
    if (logDate.indexOf(thisMonth) !== 0) continue;
    var logEmail = String(logRows[j][5] || '').trim().toLowerCase();
    if (email && logEmail && logEmail !== email) continue;
    var lBank = String(logRows[j][1] || '').trim();
    var lBranch = String(logRows[j][2] || '').trim();
    if (!lBank || !lBranch) continue;
    var lKey = normalizeText(lBank) + '|' + normalizeText(lBranch);
    if (!visitedByBank[lBank]) visitedByBank[lBank] = {};
    visitedByBank[lBank][lKey] = true;
  }

  var banks = Object.keys(targetBranchesByBank);
  var result = banks.map(function (bank) {
    var targetKeys = Object.keys(targetBranchesByBank[bank]);
    var visitedKeys = visitedByBank[bank] ? Object.keys(visitedByBank[bank]) : [];
    var visitedTargetCount = targetKeys.filter(function (k) { return visitedByBank[bank] && visitedByBank[bank][k]; }).length;
    return {
      은행명: bank,
      모수: targetKeys.length,
      당월방문: visitedTargetCount,
      미방문: targetKeys.length - visitedTargetCount
    };
  });

  return { ok: true, month: thisMonth, banks: result };
}

// 대시보드에서 특정 은행을 눌렀을 때, 그 은행의 영업대상 지점 전체를 방문/미방문으로 나눠서 보여줌
function handleDashboardBank(bankName) {
  var email = getCurrentUserEmail().toLowerCase();
  var normBank = normalizeText(bankName);
  var sheet = getSS().getSheetByName(SHEET_SELLER);
  var rows = sheet.getDataRange().getValues();
  var bankCol = fillMergedColumn(rows, 1);
  var branchCol = fillMergedColumn(rows, 2);

  var targetBranches = {}; // normBranch -> 풀네임 (영업대상으로 체크된 지점만)
  for (var i = 1; i < rows.length; i++) {
    var rowEmail = String(rows[i][11] || '').trim().toLowerCase();
    if (email && rowEmail && rowEmail !== email) continue;
    if (!textMatches(normalizeText(bankCol[i]), normBank)) continue;
    var isTarget = rows[i][10] === true || String(rows[i][10] || '').toUpperCase() === 'TRUE';
    if (!isTarget) continue;
    var branch = String(branchCol[i] || '').trim();
    if (!branch) continue;
    targetBranches[normalizeText(branch)] = branch;
  }

  var thisMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  var logSheet = getSS().getSheetByName(SHEET_LOG);
  var logRows = logSheet.getDataRange().getValues();
  var visited = {}; // normBranch -> true (이번 달 방문)
  for (var j = 1; j < logRows.length; j++) {
    var logDate = String(logRows[j][0] || '');
    if (logDate.indexOf(thisMonth) !== 0) continue;
    var logEmail = String(logRows[j][5] || '').trim().toLowerCase();
    if (email && logEmail && logEmail !== email) continue;
    if (!textMatches(normalizeText(logRows[j][1] || ''), normBank)) continue;
    var lBranch = String(logRows[j][2] || '').trim();
    if (!lBranch) continue;
    visited[normalizeText(lBranch)] = true;
  }

  var branches = Object.keys(targetBranches).map(function (key) {
    return { 지점명: targetBranches[key], visited: !!visited[key] };
  }).sort(function (a, b) { return a.지점명.localeCompare(b.지점명, 'ko'); });

  return { ok: true, 은행명: bankName, branches: branches };
}

// 제안서 요청 시트 전체를 화면에서 실시간으로 보기 위한 목록
function handleListProposals() {
  var sheet = getSS().getSheetByName(SHEET_PROPOSAL);
  var rows = sheet.getDataRange().getValues();
  var header = rows[0];
  var items = [];
  for (var i = 1; i < rows.length; i++) {
    var obj = { rowIndex: i + 1 };
    header.forEach(function (h, c) { obj[h] = rows[i][c]; });
    items.push(obj);
  }
  return { ok: true, header: header, items: items };
}

// 제안서 요청 한 행을 화면에서 수정(처리상태 토글 포함)한 내용을 저장
function handleUpdateProposal(rowIndex, data) {
  var sheet = getSS().getSheetByName(SHEET_PROPOSAL);
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var values = header.map(function (h) { return data[h] !== undefined ? data[h] : ''; });
  sheet.getRange(rowIndex, 1, 1, header.length).setValues([values]);
  return { ok: true };
}

function sanitizeText(text) {
  return String(text || '')
    .replace(/[#*_`>{}\[\]\\|~^]/g, '')
    .replace(/^[\s\-]+/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function callClaude(prompt) {
  var text = callClaudeText(prompt + '\n\nJSON만 출력하세요. 다른 설명은 붙이지 마세요.');
  var jsonMatch = text.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch ? jsonMatch[0] : text);
}

// 스크립트 속성(프로젝트 설정 > 스크립트 속성)에 CLAUDE_API_KEY가 설정되어 있으면 그것을 우선 사용하고,
// 없으면 위쪽의 CLAUDE_API_KEY 변수를 사용한다. 앞뒤 공백은 항상 제거해서 붙여넣기 실수를 방지한다.
function getClaudeApiKey() {
  var fromProps = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  var key = (fromProps || CLAUDE_API_KEY || '').trim();
  if (!key || key === 'YOUR_CLAUDE_API_KEY_HERE') {
    throw new Error('CLAUDE_API_KEY가 설정되지 않았습니다. 프로젝트 설정 > 스크립트 속성에 CLAUDE_API_KEY를 추가하거나, Code.gs 맨 위 변수에 실제 Anthropic API 키를 입력하세요.');
  }
  return key;
}

function getCurrentUserEmail() {
  return Session.getActiveUser().getEmail() || '';
}

function handleGetMe() {
  var email = getCurrentUserEmail();
  if (!email) return { ok: false, error: 'login_required' };
  var usersSheet = getSS().getSheetByName(SHEET_USERS);
  if (!usersSheet) return { ok: false, error: 'no_users_sheet' };
  var rows = usersSheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][1] || '').trim().toLowerCase() === email.toLowerCase()) {
      return { ok: true, name: String(rows[i][0] || '').trim(), email: email };
    }
  }
  return { ok: false, error: 'not_registered', email: email };
}

// === 업무 LIST ===
// 컬럼: [id, 순서, 입력일, 대상유형(거래처/직접입력), 은행, 지점, 판매자명, 직책, 대상텍스트, 메모, 알람일시, 담당자이메일]
function getTasksSheet() {
  var ss = getSS();
  var sheet = ss.getSheetByName(SHEET_TASKS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_TASKS);
    sheet.appendRow(['id', '순서', '입력일', '대상유형', '은행', '지점', '판매자명', '직책', '대상텍스트', '메모', '알람일시', '담당자이메일']);
  }
  return sheet;
}

function getTasksDoneSheet() {
  var ss = getSS();
  var sheet = ss.getSheetByName(SHEET_TASKS_DONE);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_TASKS_DONE);
    sheet.appendRow(['id', '입력일', '대상유형', '은행', '지점', '판매자명', '직책', '대상텍스트', '메모', '알람일시', '담당자이메일', '처리일시']);
  }
  return sheet;
}

function taskRowToObj(r) {
  return {
    id: String(r[0] || ''), 순서: Number(r[1]) || 0, 입력일: String(r[2] || ''),
    대상유형: String(r[3] || ''), 은행: String(r[4] || ''), 지점: String(r[5] || ''),
    판매자명: String(r[6] || ''), 직책: String(r[7] || ''), 대상텍스트: String(r[8] || ''),
    메모: String(r[9] || ''), 알람일시: String(r[10] || ''), 담당자이메일: String(r[11] || '')
  };
}

// 내 업무 목록(우선순위 순)
function handleListTasks() {
  var email = getCurrentUserEmail().toLowerCase();
  var sheet = getTasksSheet();
  var rows = sheet.getDataRange().getValues();
  var tasks = [];
  for (var i = 1; i < rows.length; i++) {
    var rowEmail = String(rows[i][11] || '').trim().toLowerCase();
    if (email && rowEmail && rowEmail !== email) continue;
    if (!rows[i][0]) continue;
    tasks.push(taskRowToObj(rows[i]));
  }
  tasks.sort(function (a, b) { return a.순서 - b.순서; });
  return { ok: true, tasks: tasks };
}

// 새 업무 추가
function handleAddTask(data) {
  var email = getCurrentUserEmail();
  var sheet = getTasksSheet();
  var rows = sheet.getDataRange().getValues();
  var maxOrder = 0;
  for (var i = 1; i < rows.length; i++) {
    var o = Number(rows[i][1]) || 0;
    if (o > maxOrder) maxOrder = o;
  }
  var id = Utilities.getUuid();
  var todayLabel = resolveDateLabel('');
  var targetType = String(data.targetType || '거래처') === '직접입력' ? '직접입력' : '거래처';
  sheet.appendRow([
    id, maxOrder + 1, todayLabel, targetType,
    targetType === '거래처' ? String(data.bank || '').trim() : '',
    targetType === '거래처' ? String(data.branch || '').trim() : '',
    targetType === '거래처' ? String(data.seller || '').trim() : '',
    targetType === '거래처' ? String(data.title || '').trim() : '',
    targetType === '직접입력' ? String(data.targetText || '').trim() : '',
    String(data.memo || '').trim(),
    String(data.alarm || '').trim(),
    email
  ]);
  return { ok: true, id: id };
}

// 업무 내용 수정 (대상/메모 변경, 순서·입력일·알람은 유지)
function handleEditTask(id, data) {
  if (!id) return { ok: false, message: 'id가 없습니다.' };
  var sheet = getTasksSheet();
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === id) {
      var targetType = String(data.targetType || '거래처') === '직접입력' ? '직접입력' : '거래처';
      var rowNum = i + 1;
      sheet.getRange(rowNum, 4, 1, 6).setValues([[
        targetType,
        targetType === '거래처' ? String(data.bank || '').trim() : '',
        targetType === '거래처' ? String(data.branch || '').trim() : '',
        targetType === '거래처' ? String(data.seller || '').trim() : '',
        targetType === '거래처' ? String(data.title || '').trim() : '',
        targetType === '직접입력' ? String(data.targetText || '').trim() : ''
      ]]);
      sheet.getRange(rowNum, 10, 1, 1).setValue(String(data.memo || '').trim());
      return { ok: true };
    }
  }
  return { ok: false, message: '해당 업무를 찾을 수 없습니다.' };
}

// 업무 완료 처리: 완료된업무로 이동
function handleCompleteTask(id) {
  if (!id) return { ok: false, message: 'id가 없습니다.' };
  var sheet = getTasksSheet();
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === id) {
      var r = rows[i];
      var doneSheet = getTasksDoneSheet();
      var doneAt = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
      doneSheet.appendRow([r[0], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], doneAt]);
      sheet.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, message: '해당 업무를 찾을 수 없습니다.' };
}

// 업무 우선순위 위/아래 이동: 같은 사용자 목록 내에서 인접한 항목과 순서값을 교체
function handleMoveTask(id, direction) {
  if (!id) return { ok: false, message: 'id가 없습니다.' };
  var email = getCurrentUserEmail().toLowerCase();
  var sheet = getTasksSheet();
  var rows = sheet.getDataRange().getValues();

  var mine = []; // { rowNum, id, order }
  for (var i = 1; i < rows.length; i++) {
    var rowEmail = String(rows[i][11] || '').trim().toLowerCase();
    if (email && rowEmail && rowEmail !== email) continue;
    if (!rows[i][0]) continue;
    mine.push({ rowNum: i + 1, id: String(rows[i][0]), order: Number(rows[i][1]) || 0 });
  }
  mine.sort(function (a, b) { return a.order - b.order; });

  var idx = mine.findIndex(function (t) { return t.id === id; });
  if (idx === -1) return { ok: false, message: '해당 업무를 찾을 수 없습니다.' };
  var swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= mine.length) return { ok: true }; // 이미 맨 위/아래

  var a = mine[idx], b = mine[swapIdx];
  sheet.getRange(a.rowNum, 2).setValue(b.order);
  sheet.getRange(b.rowNum, 2).setValue(a.order);
  return { ok: true };
}

// 알람 일시 설정/변경
function handleSetTaskAlarm(id, alarm) {
  if (!id) return { ok: false, message: 'id가 없습니다.' };
  var sheet = getTasksSheet();
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === id) {
      sheet.getRange(i + 1, 11).setValue(alarm || '');
      return { ok: true };
    }
  }
  return { ok: false, message: '해당 업무를 찾을 수 없습니다.' };
}

// 완료된 업무 목록(최근 처리 순)
function handleListCompletedTasks() {
  var email = getCurrentUserEmail().toLowerCase();
  var sheet = getTasksDoneSheet();
  var rows = sheet.getDataRange().getValues();
  var tasks = [];
  for (var i = 1; i < rows.length; i++) {
    var rowEmail = String(rows[i][10] || '').trim().toLowerCase();
    if (email && rowEmail && rowEmail !== email) continue;
    if (!rows[i][0]) continue;
    tasks.push({
      id: String(rows[i][0] || ''), 입력일: String(rows[i][1] || ''),
      대상유형: String(rows[i][2] || ''), 은행: String(rows[i][3] || ''), 지점: String(rows[i][4] || ''),
      판매자명: String(rows[i][5] || ''), 직책: String(rows[i][6] || ''), 대상텍스트: String(rows[i][7] || ''),
      메모: String(rows[i][8] || ''), 알람일시: String(rows[i][9] || ''), 담당자이메일: String(rows[i][10] || ''),
      처리일시: String(rows[i][11] || '')
    });
  }
  tasks.sort(function (a, b) { return b.처리일시.localeCompare(a.처리일시); });
  return { ok: true, tasks: tasks };
}

function callClaudeText(prompt) {
  var apiKey = getClaudeApiKey();
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    }),
    muteHttpExceptions: true
  });
  var json = JSON.parse(res.getContentText());
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.content[0].text;
}
