const names = new URLSearchParams(location.search).get('f').split(',');
for (const n of names) { const f = document.createElement('figure'); f.innerHTML = `<img src="../../shots/${n}.png"><figcaption>${n}</figcaption>`; document.getElementById('g').appendChild(f); }
