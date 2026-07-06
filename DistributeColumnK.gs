// === 설정 ===
// 이미 "방카 자비스" 프로젝트에 CLAUDE_API_KEY와 callClaude/callClaudeText가 있다면
// 이 파일에서 중복되는 함수(callClaude, callClaudeText)는 지우고 그대로 쓰면 됩니다.
// 별도 스프레드시트/스크립트라면 이 파일 그대로 새 프로젝트에 붙여넣으면 됩니다.

var K_CLAUDE_API_KEY = 'YOUR_CLAUDE_API_KEY_HERE';

// "은행분석 및 방문정리" 시트의 1번 탭에서 실행하세요.
// K열(기타대화내용에 몰아넣은 원본)을 읽어서 F~J(가족관계/자택/판매성향/방문이력/기타대화내용)로 분배합니다.
// 이미 F~J가 채워진 행은 건너뜁니다 (중간에 멈춰도 다시 실행하면 이어서 처리됨).
function redistributeColumnK() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var lastRow = sheet.getLastRow();

  for (var row = 2; row <= lastRow; row++) {
    var fToJ = sheet.getRange(row, 6, 1, 5).getValues()[0];
    var alreadyFilled = fToJ.some(function (v) { return String(v || '').trim(); });
    var kText = String(sheet.getRange(row, 11).getValue() || '').trim();

    if (!kText || alreadyFilled) continue;

    var data = classifyMiscText(kText);
    sheet.getRange(row, 6, 1, 5).setValues([[
      data['가족관계'] || '', data['자택'] || '', data['판매성향'] || '',
      data['방문이력'] || '', data['기타대화내용'] || ''
    ]]);

    Utilities.sleep(300); // API 과호출 방지용 약간의 대기
  }
}

function classifyMiscText(text) {
  var prompt = '다음은 은행 판매자에 대해 정리되지 않은 상태로 메모해둔 텍스트입니다. ' +
    '이 내용을 아래 5개 항목 중 적절한 곳에 나누어 넣어주세요. 한 메모에 여러 항목 내용이 섞여 있으면 분리해서 각각 넣고, ' +
    '해당 항목에 들어갈 내용이 없으면 빈 문자열로 두세요. 원문의 표현은 최대한 그대로 유지하세요(요약하거나 바꿔쓰지 마세요).\n\n' +
    '- 가족관계: 결혼여부, 배우자, 자녀 관련 내용\n' +
    '- 자택: 거주지, 사는 곳, 출신/연고 지역 관련 내용\n' +
    '- 판매성향: 방카슈랑스 판매 경험/실력/태도/영업 스타일 관련 내용 (예: 방카 처음, 판매력 좋음, 환급률을 중시함, 핵심 판매자)\n' +
    '- 방문이력: 발령/이동/신규배치 등 언제 어디서 왔는지 같은 인사이동 이력 (예: (26.1) 신규, OO에서 오심, 26.1월 승진)\n' +
    '- 기타대화내용: 위 4개에 속하지 않는 나머지 모든 내용 (취미, 성격, 특이사항, 잡담 등)\n\n' +
    'JSON으로만 답하세요:\n' +
    '{ "가족관계": "", "자택": "", "판매성향": "", "방문이력": "", "기타대화내용": "" }\n\n' +
    '원문: ' + text;

  var responseText = callClaudeText(prompt + '\n\nJSON 객체 딱 하나만 출력하세요. 그 외 텍스트나 설명, 반복은 절대 넣지 마세요.');
  return JSON.parse(extractFirstJsonObject(responseText));
}

// 응답에 JSON 객체가 중복되거나 뒤에 불필요한 텍스트가 붙어도, 첫 번째 완전한 객체만 안전하게 추출
function extractFirstJsonObject(text) {
  var start = text.indexOf('{');
  if (start === -1) throw new Error('JSON을 찾을 수 없습니다: ' + text);
  var depth = 0;
  for (var i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.substring(start, i + 1);
    }
  }
  throw new Error('완전한 JSON 객체를 찾을 수 없습니다: ' + text);
}

function callClaudeText(prompt) {
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': K_CLAUDE_API_KEY,
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
