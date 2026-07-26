// TEMPORARY SPIKE — replaced in Task 9.
// Sends one request with a deliberately invalid token. We do not care about
// auth; we care whether the response is JSON (we reached Django, so a
// User-Agent was present) or HTML (nginx blocked us for having none).
Pebble.addEventListener('ready', function () {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', 'https://fireboard.io/api/v1/devices.json');
  xhr.setRequestHeader('Authorization', 'Token 0000000000000000000000000000000000000000');
  try {
    xhr.setRequestHeader('User-Agent', 'pebble-fireboard/0.1');
    console.log('SPIKE: setRequestHeader(User-Agent) did not throw');
  } catch (e) {
    console.log('SPIKE: setRequestHeader(User-Agent) threw: ' + e.message);
  }
  xhr.onload = function () {
    var body = xhr.responseText || '';
    console.log('SPIKE status=' + xhr.status);
    console.log('SPIKE body[0:120]=' + body.substring(0, 120));
    if (body.indexOf('<html') !== -1 || body.indexOf('<HTML') !== -1) {
      console.log('SPIKE RESULT: HTML -> NO User-Agent sent. ARCHITECTURE BLOCKED.');
    } else if (body.indexOf('detail') !== -1) {
      console.log('SPIKE RESULT: JSON -> User-Agent present. PROCEED.');
    } else {
      console.log('SPIKE RESULT: unexpected body, inspect manually.');
    }
  };
  xhr.onerror = function () { console.log('SPIKE: network error'); };
  xhr.send(null);
});
