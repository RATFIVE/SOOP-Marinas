// Dashboard-Logik für STA-Datenbank
// 1. Karte initialisieren
// 2. Locations von STA-API laden und Marker setzen
// 3. Beim Klick auf Marker Zeitreihe laden und anzeigen

// Schleswig-Holstein: Mittelpunkt ca. [54.4, 9.7], Zoom 8
// Dynamische Zoom-Stufe je nach Bildschirmbreite
const isMobile = window.innerWidth < 700; // Schwelle ggf. anpassen
const initialZoom = isMobile ? 5 : 7; // Adjusted zoom levels for mobile and desktop to zoom out more
const map = L.map('map', {
    zoomControl: false,
    dragging: true, // Verschieben deaktiviert
    scrollWheelZoom: false, // Scrollen deaktiviert
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false
}).setView([54.4, 9.7], initialZoom);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

const FROST_API = 'https://timeseries.geomar.de/soop/FROST-Server/v1.1';

let isAdmin = false;

const dataSection = document.getElementById('dataSection');
const dataTitle = document.getElementById('dataTitle');
const datastreamSelect = document.getElementById('datastreamSelect');
const timeRangeSelect = document.getElementById('timeRangeSelect');
const chartContainer = document.getElementById('chartContainer');

// Drag & Drop für das Popup
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

// Leaflet Marker-Icon in SOOP-Rot
const soopRedIcon = new L.Icon({
    iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png',
    shadowUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-shadow.png',
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    shadowSize: [41, 41]
});

// Übersicht für battery_voltage aller Geräte (nur für Admin)
let batteryOverview = null;
function showBatteryOverview(batteryData) {
    if (!batteryOverview) {
        batteryOverview = document.createElement('div');
        batteryOverview.id = 'batteryOverview';
        batteryOverview.style.position = 'fixed';
        batteryOverview.style.top = '80px';
        batteryOverview.style.right = '40px';
        batteryOverview.style.zIndex = 2003;
        batteryOverview.style.background = '#fff';
        batteryOverview.style.color = 'var(--soop-blue)';
        batteryOverview.style.border = '2px solid var(--soop-green)';
        batteryOverview.style.borderRadius = '12px';
        batteryOverview.style.boxShadow = '0 2px 16px rgba(5,50,70,0.18)';
        batteryOverview.style.padding = '16px 20px';
        batteryOverview.style.minWidth = '220px';
        batteryOverview.style.maxHeight = '60vh';
        batteryOverview.style.overflowY = 'auto';
        batteryOverview.style.cursor = 'move';
        batteryOverview.innerHTML = '<b>Spannung aller Geräte</b><span id="batteryOverviewClose" style="float:right;cursor:pointer;font-size:1.2em;">&times;</span><br><div id="batteryList"></div>';
        document.body.appendChild(batteryOverview);
        // Drag & Drop-Logik
        let isDragging = false, dragOffsetX = 0, dragOffsetY = 0;
        batteryOverview.addEventListener('mousedown', function(e) {
            if (e.target.id === 'batteryOverviewClose') return;
            isDragging = true;
            dragOffsetX = e.clientX - batteryOverview.getBoundingClientRect().left;
            dragOffsetY = e.clientY - batteryOverview.getBoundingClientRect().top;
            document.body.style.userSelect = 'none';
        });
        document.addEventListener('mousemove', function(e) {
            if (isDragging) {
                batteryOverview.style.left = (e.clientX - dragOffsetX) + 'px';
                batteryOverview.style.top = (e.clientY - dragOffsetY) + 'px';
                batteryOverview.style.right = '';
            }
        });
        document.addEventListener('mouseup', function() {
            isDragging = false;
            document.body.style.userSelect = '';
        });
        // Schließen-Button
        batteryOverview.querySelector('#batteryOverviewClose').onclick = function() {
            hideBatteryOverview();
        };
    }
    const list = batteryOverview.querySelector('#batteryList');
    list.innerHTML = batteryData.map(b => `<div style="margin-bottom:6px;"><b>${b.name}</b>: <span style="color:${b.value < 3.5 ? 'var(--soop-red)' : 'var(--soop-green)'}">${b.value ? b.value.toFixed(2) + ' V' : 'n/a'}</span></div>`).join('');
    batteryOverview.style.display = 'block';
}
function hideBatteryOverview() {
    if (batteryOverview) {
        batteryOverview.remove();
        batteryOverview = null;
    }
}

async function fetchLocations() {
    try {
        const resp = await fetch(`${FROST_API}/Things?$expand=Locations`);
        if (!resp.ok) {
            console.error('Fehler beim Abrufen der Things:', resp.status, resp.statusText);
            return [];
        }
        const data = await resp.json();
        if (!data.value) {
            console.error('API-Antwort enthält kein value-Array:', data);
            return [];
        }
        // Debug: Logge alle Thing-Namen und IDs
        data.value.forEach(t => console.log('Thing:', t.name, 'ID:', t['@iot.id']));
        // Filter: Nur bestimmte Things zulassen
        const erlaubteThings = [
            'box_gmr_twl-box_0924005',
            'box_gmr_twl-box_0924002',
            'Badesteg Reventlou',
            'box_gmr_twl-box_0924004'
        ];
        if (isAdmin) erlaubteThings.push('box_gmr_twl-box_0924004');
        let filteredThings = data.value.filter(thing => erlaubteThings.includes(thing.name));
        // Nachträglich für Nicht-Admins rausfiltern
        filteredThings = filteredThings.filter(thing => {
            if (thing.name === 'box_gmr_twl-box_09240041' && !isAdmin) return false;
            return true;
        });
        // Für alle relevanten Things: Location holen (entweder aus Locations oder aus Datastreams latitude/longitude)
        const locations = await Promise.all(filteredThings.map(async thing => {
            let lat = null, lon = null;
            let loc = thing.Locations && thing.Locations[0] && thing.Locations[0].location && thing.Locations[0].location.coordinates ? thing.Locations[0] : null;
            if (loc) {
                lon = loc.location.coordinates[0];
                lat = loc.location.coordinates[1];
            } else {
                // Hole alle Datastreams und suche nach latitude/longitude
                try {
                    const dsResp = await fetch(`${FROST_API}/Things(${thing['@iot.id']})/Datastreams`);
                    if (dsResp.ok) {
                        const dsData = await dsResp.json();
                        const latDs = dsData.value.find(ds => ds.name && ds.name.toLowerCase().startsWith('latitude'));
                        const lonDs = dsData.value.find(ds => ds.name && ds.name.toLowerCase().startsWith('longitude'));
                        // Hole letzte Observation für beide
                        if (latDs && lonDs) {
                            const [latObsResp, lonObsResp] = await Promise.all([
                                fetch(`${FROST_API}/Datastreams(${latDs['@iot.id']})/Observations?$top=1&$orderby=phenomenonTime desc`),
                                fetch(`${FROST_API}/Datastreams(${lonDs['@iot.id']})/Observations?$top=1&$orderby=phenomenonTime desc`)
                            ]);
                            if (latObsResp.ok && lonObsResp.ok) {
                                const latObsData = await latObsResp.json();
                                const lonObsData = await lonObsResp.json();
                                if (latObsData.value.length > 0 && lonObsData.value.length > 0) {
                                    lat = latObsData.value[0].result;
                                    lon = lonObsData.value[0].result;
                                }
                            }
                        }
                    }
                } catch (err) {
                    console.warn('Fehler beim Nachladen von Lat/Lon aus Datastreams für', thing.name, err);
                }
            }
            let anzeigeName = thing.name;
            if (thing.name === 'box_gmr_twl-box_0924005') anzeigeName = 'Im Jaich, Stadthafen Flensburg';
            if (thing.name === 'box_gmr_twl-box_0924002') anzeigeName = 'Kappeln/Grauhöft, Werfthafen Stapelfeld';
            if (thing.name === 'Badesteg Reventlou') anzeigeName = 'Badesteg Reventlou';
            if (thing.name === 'box_gmr_twl-box_0924004') anzeigeName = 'Schilksee';
            return {
                id: thing['@iot.id'],
                name: thing.name,
                anzeigeName: anzeigeName,
                lat,
                lon
            };
        }));
        // Filtere raus, wenn keine Koordinaten gefunden wurden
        return locations.filter(l => l.lat !== null && l.lon !== null);
    } catch (err) {
        console.error('Fehler beim Laden der Things:', err);
        return [];
    }
}

async function fetchDatastreams(thingId) {
    const resp = await fetch(`${FROST_API}/Things(${thingId})/Datastreams`);
    const data = await resp.json();
    return data.value[0]; // Nimm den ersten Datastream
}

async function fetchDatastreamsAll(thingId) {
    const resp = await fetch(`${FROST_API}/Things(${thingId})/Datastreams`);
    const data = await resp.json();
    return data.value;
}

async function fetchAllBatteryVoltages(locations) {
    // Für alle Things: Finde battery_voltage-Datastream, hole letzte Observation
    const results = [];
    for (const loc of locations) {
        const datastreams = await fetchDatastreamsAll(loc.id);
        const battDs = datastreams.find(ds => ds.name && ds.name.toLowerCase().startsWith('battery_voltage'));
        let value = null;
        if (battDs) {
            const obsResp = await fetch(`${FROST_API}/Datastreams(${battDs['@iot.id']})/Observations?$top=1&$orderby=phenomenonTime desc`);
            const obsData = await obsResp.json();
            if (obsData.value.length > 0) value = obsData.value[0].result;
        }
        results.push({name: loc.name, value});
    }
    return results;
}

function getTimeFilter(range) {
    const now = new Date();
    let from;
    if (range === '24h') {
        from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    } else if (range === '7d') {
        from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (range === '1y') {
        // 365 Tage statt 356 Tage
        from = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    } else {
        from = null;
    }
    return from ? from.toISOString() : null;
}

async function fetchObservations(datastreamId, timeRange) {
    const spinner = document.getElementById('loadingSpinner');
    if (spinner) spinner.style.display = 'block'; // Show spinner

    let from = getTimeFilter(timeRange);
    let url = `${FROST_API}/Datastreams(${datastreamId})/Observations?$orderby=phenomenonTime asc`;
    if (from) {
        url += `&$filter=phenomenonTime ge ${from}`;
    }

    let allData = [];
    try {
        while (url) {
            const resp = await fetch(url);
            const data = await resp.json();
            allData = allData.concat(data.value);
            url = data['@iot.nextLink'] || null;
        }
    } catch (error) {
        console.error('Fehler beim Abrufen der Daten:', error);
    } finally {
        if (spinner) spinner.style.display = 'none'; // Hide spinner
    }

    return allData;
}




function ensureTimeseriesCanvas() {
    let canvas = document.getElementById('timeseriesChart');
    if (!canvas) {
        const chartContainer = document.getElementById('chartContainer');
        if (chartContainer) {
            chartContainer.innerHTML = '';
            canvas = document.createElement('canvas');
            canvas.id = 'timeseriesChart';
            chartContainer.appendChild(canvas);
        }
    }
    return canvas;
}

function renderChart(observations = [], title = 'Messwert') {
  const canvas = ensureTimeseriesCanvas();
  if (!canvas) {
    console.error('Canvas für Chart nicht gefunden!');
    return;
  }
  const ctx = canvas.getContext('2d');

  if (window.tsChart) {
    window.tsChart.destroy();
  }

  const dataPoints = observations
    .map(o => {
      const x = new Date(o.phenomenonTime);
      const y = typeof o.result === 'number'
        ? o.result
        : parseFloat(o.result);
      return { x, y };
    })
    .filter(pt => !isNaN(pt.x) && !isNaN(pt.y));

  let minY, maxY;
  if (dataPoints.length > 0) {
    const ys = dataPoints.map(pt => pt.y);
    const min = Math.min(...ys);
    const max = Math.max(...ys);
    const range = max - min;
    const pad = range === 0
      ? (min === 0 ? 1 : Math.abs(min) * 0.1)
      : range * 0.1;
    minY = min - pad;
    maxY = max + pad;
  }

  const config = {
    type: 'line',
    data: {
        datasets: [{
            label: title,
            data: dataPoints,
            borderColor: '#78D278',
            backgroundColor: 'rgba(120,210,120,0.15)',
            fill: true,
            pointRadius: 0 // Remove points from the line chart
        }]
    },
    options: {
      responsive: true,
      plugins: {
        title: { display: true, text: title, font: { size: 16 } },
        legend: { display: false } // Legende deaktiviert für Wassertemperatur
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'day' },
          title: { display: true, text: 'Zeit', font: { size: 16 } },
          ticks: { font: { size: 16 } } // Schriftgröße für die X-Achsen-Beschriftungen
        },
        y: {
          title: { display: true, text: '°C', font: { size: 16 } },
          ticks: { font: { size: 16 } } // Schriftgröße für die Y-Achsen-Beschriftungen
        }
      }
    }
  };

  if (minY != null) config.options.scales.y.min = minY;
  if (maxY != null) config.options.scales.y.max = maxY;

  window.tsChart = new Chart(ctx, config);
}


// Neue Funktion für Multi-Liniendiagramm
const renderChartMulti = (datasets, title = 'Messwerte') => {
    const canvas = ensureTimeseriesCanvas();
    if (!canvas) {
        console.error('Canvas für Chart nicht gefunden!');
        return;
    }
    const ctx = canvas.getContext('2d');
    if (window.tsChart) window.tsChart.destroy();

    let minY = undefined, maxY = undefined;
    const allValues = datasets.flatMap(ds => ds.data.map(d => d.y).filter(v => typeof v === 'number'));
    if (allValues.length > 0) {
        const min = Math.min(...allValues);
        const max = Math.max(...allValues);
        const range = max - min;
        const padding = range === 0 ? (min === 0 ? 1 : Math.abs(min) * 0.1) : range * 0.1;
        minY = min - padding;
        maxY = max + padding;
    }

    const colorPalette = [
        '#78D278', '#FF6666', '#053246', '#FFA500', '#8A2BE2', '#00BFFF', '#FFD700', '#FF69B4', '#A0522D', '#20B2AA'
    ];

    function shortLabel(name) {
        return name.split('*')[0].trim();
    }

    let allLabels = [];
    datasets.forEach(ds => {
        allLabels = allLabels.concat(ds.data.map(d => d.x));
    });
    allLabels = Array.from(new Set(allLabels)).sort();

    const chartData = {
        labels: allLabels,
        datasets: datasets.map((ds, i) => ({
            ...ds,
            label: shortLabel(ds.label),
            borderColor: colorPalette[i % colorPalette.length],
            backgroundColor: colorPalette[i % colorPalette.length] + '33',
            data: allLabels.map(label => {
                const found = ds.data.find(d => d.x === label);
                return found ? found.y : null;
            })
        }))
    };

    window.tsChart = new Chart(ctx, {
        type: 'line',
        data: chartData,
        options: {
            responsive: true,
            plugins: {
                title: {
                    display: true,
                    text: 'Wasserstand und Wellenhöhe', // Entferne Standardabweichung aus der Überschrift
                    font: {
                        size: 16 // Schriftgröße für den Titel
                    }
                },
                legend: {
                    display: true, // Legende aktiviert für Wasserstand, Standardabweichung, Wellenhöhe
                    labels: {
                        font: {
                            size: 16 // Schriftgröße für die Legende
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: { unit: 'day' },
                    title: {
                        display: true,
                        text: 'Zeit',
                        font: {
                            size: 16 // Schriftgröße für die X-Achse
                        }
                    },
                    ticks: {
                        font: {
                            size: 16 // Schriftgröße für die X-Achsen-Beschriftungen
                        }
                    }
                },
                y: {
                    title: {
                        display: true,
                        text: 'cm',
                        font: {
                            size: 16 // Schriftgröße für die Y-Achse
                        }
                    },
                    ticks: {
                        font: {
                            size: 16 // Schriftgröße für die Y-Achsen-Beschriftungen
                        }
                    }
                }
            }
        }
    });
};

// Login-Logik für Admin
const loginForm = document.getElementById('loginForm');
const loginStatus = document.getElementById('loginStatus');
const loginBox = document.getElementById('loginBox');

if (loginForm) {
    loginForm.onsubmit = function(e) {
        e.preventDefault();
        const user = document.getElementById('username').value;
        const pw = document.getElementById('password').value;
        // Dummy-Login: admin / admin123
        if (user === 'admin' && pw === 'admin123') {
            loginStatus.textContent = 'Login erfolgreich!';
            loginStatus.style.color = 'green';
            isAdmin = true; // <-- Vor Funktionsaufrufen setzen!
            setTimeout(async () => {
                loginBox.style.display = 'none';
                showLogoutButton();
                // Admin: Zeige battery_voltage Übersicht
                const locations = await fetchLocations();
                const batteryData = await fetchAllBatteryVoltages(locations);
                showBatteryOverview(batteryData);
            }, 1000);
        } else {
            loginStatus.textContent = 'Login fehlgeschlagen!';
            loginStatus.style.color = 'red';
        }
    };
}

// Bereich unter der Karte initial leeren
window.addEventListener('DOMContentLoaded', async () => {
    if (dataTitle) dataTitle.textContent = '';
    if (chartContainer) chartContainer.innerHTML = '';
    // Starte main explizit nach DOM-Load
    await main();

    // Lade Daten für 'Im Jaich, Stadthafen Flensburg'
    const flensburgMarina = locationsCache.find(loc => loc.anzeigeName === 'Im Jaich, Stadthafen Flensburg');
    if (flensburgMarina) {
        marinaSelect.value = flensburgMarina.id;
        showMarinaData(flensburgMarina.id);
    }
});

// Marinas für Auswahlbox
const marinaOptions = [
    { id: null, name: 'Bitte wählen ...' },
    { id: null, name: '---' },
    { id: null, name: 'Im Jaich, Stadthafen Flensburg' },
    { id: null, name: 'Marina Kappel' },
    { id: null, name: 'Badesteg Reventlou' }
    // box_gmr_twl-box_0924004 wird nicht mehr statisch gelistet
];

// Marina-Auswahlbox wird nicht mehr dynamisch erzeugt, sondern aus dem HTML gelesen.
const marinaSelect = document.getElementById('marinaSelect');
let locationsCache = [];

// Bereich für die letzten Messwerte unterhalb der Karte, aber oberhalb des Diagramms
const lastValuesTableContainer = document.createElement('div');
lastValuesTableContainer.id = 'lastValuesTableContainer';
lastValuesTableContainer.style.maxWidth = '900px';
lastValuesTableContainer.style.margin = '24px auto 0 auto';
lastValuesTableContainer.style.background = '#fff';
lastValuesTableContainer.style.borderRadius = '8px';
lastValuesTableContainer.style.boxShadow = '0 2px 8px rgba(5,50,70,0.08)';
lastValuesTableContainer.style.padding = '18px 18px 12px 18px';
lastValuesTableContainer.style.display = 'none';

// Füge den Container in den dataContent-Bereich ein (vor dem Chart)
const dataContent = document.getElementById('dataContent');
if (dataContent) {
    const chartContainer = document.getElementById('chartContainer');
    dataContent.insertBefore(lastValuesTableContainer, chartContainer);
}

// Hilfsfunktion: Tabelle der letzten Messwerte rendern
async function renderLastValuesTable(loc) {
    lastValuesTableContainer.innerHTML = '';
    lastValuesTableContainer.style.display = 'none';
    if (!loc) return;
    const datastreams = await fetchDatastreamsAll(loc.id);
    let filteredDatastreams = datastreams.filter(ds => {
        const n = ds.name.toLowerCase();
        if (n.startsWith('latitude') || n.startsWith('longitude')) return false;
        // Battery Voltage nur für Admin
        const dsShortName = ds.name.split('*')[0].trim();
        if (isBatteryVoltage(dsShortName) && !isAdmin) return false;
        // Standardabweichung nur für Admin
        if (dsShortName.toLowerCase() === 'standard_deviation' && !isAdmin) return false;
        return true;
    });
    if (!filteredDatastreams.length) return;
    // Hole für jeden Datastream die letzte Observation
    const lastValues = await Promise.all(filteredDatastreams.map(async ds => {
        const dsShortName = ds.name.split('*')[0].trim();
        const displayName = getDisplayName(dsShortName);
        const unit = getUnit(dsShortName);
        try {
            const obsResp = await fetch(`${FROST_API}/Datastreams(${ds['@iot.id']})/Observations?$top=1&$orderby=phenomenonTime desc`);
            if (obsResp.ok) {
                const obsData = await obsResp.json();
                if (obsData.value.length > 0) {
                    const obs = obsData.value[0];
                    const dateObj = new Date(obs.phenomenonTime);
                    const dateStr = dateObj.toLocaleDateString('de-DE');
                    const timeStr = dateObj.toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'});
                    return {
                        name: displayName,
                        value: obs.result,
                        unit: unit,
                        date: dateStr,
                        time: timeStr
                    };
                }
            }
        } catch (e) {}
        return {
            name: displayName,
            value: 'n/a',
            unit: unit,
            date: '-',
            time: '-'
        };
    }));
    // Baue die Tabelle
    let html = `<div style='font-size:1.08em;font-weight:700;margin-bottom:10px;color:#053246;'>Letzte Messwerte</div>`;
    html += `<table style='width:100%;border-collapse:collapse;'>`;
    html += `<thead><tr style='background:#f5f5f5;'><th style='text-align:left;padding:6px 8px;'>Messgröße</th><th style='text-align:right;padding:6px 8px;'>Wert</th><th style='text-align:center;padding:6px 8px;'>Datum</th><th style='text-align:center;padding:6px 8px;'>Uhrzeit</th></tr></thead>`;
    html += `<tbody>`;
    lastValues.forEach(row => {
        html += `<tr style='border-bottom:1px solid #e0e0e0;'>`;
        html += `<td style='padding:6px 8px;'>${row.name}</td>`;
        html += `<td style='padding:6px 8px;text-align:right;color:#053246;font-weight:600;'>${row.value !== 'n/a' ? row.value + ' ' + row.unit : 'n/a'}</td>`;
        html += `<td style='padding:6px 8px;text-align:center;color:#888;'>${row.date}</td>`;
        html += `<td style='padding:6px 8px;text-align:center;color:#888;'>${row.time}</td>`;
        html += `</tr>`;
    });
    html += `</tbody></table>`;
    lastValuesTableContainer.innerHTML = html;
    lastValuesTableContainer.style.display = 'block';
}



// Mapping für sprechende Namen und Einheiten
const DISPLAY_NAME_MAP = {
    'battery_voltage': { label: 'Batterie-Spannung', unit: 'V' },
    'temperature': { label: 'Temperatur', unit: '°C' },
    'temperature_water': { label: 'Wassertemperatur (ca. 30 cm unter der Wasseroberfläche)', unit: '°C' },
    'wtemp': { label: 'Wassertemperatur (ca. 30 cm unter der Wasseroberfläche)', unit: '°C' },
    'tide_measurement': { label: 'Wasserstand (Abweichung vom mittleren Wasserstand)', unit: 'cm' },
    'water_level': { label: 'Wasserstand', unit: 'cm' },
    'standard_deviation': { label: 'Standardabweichung Wasserstand', unit: 'cm' },
    'wave_height': { label: 'Wellenhöhe', unit: 'cm' },
    'windspeed': { label: 'Windgeschwindigkeit', unit: 'km/h' },
    'winddirection': { label: 'Windrichtung', unit: '°' },
    'pressure': { label: 'Luftdruck', unit: 'hPa' },
    'lufttemperatur': { label: 'Lufttemperatur', unit: '°C' },
    // weitere Zuordnungen nach Bedarf
};
function getDisplayName(shortName) {
    const key = shortName.toLowerCase().replace(/\s/g, '_');
    if (DISPLAY_NAME_MAP[key]) return DISPLAY_NAME_MAP[key].label;
    return shortName.charAt(0).toUpperCase() + shortName.slice(1);
}
function getUnit(shortName) {
    const key = shortName.toLowerCase().replace(/\s/g, '_');
    if (DISPLAY_NAME_MAP[key]) return DISPLAY_NAME_MAP[key].unit || '';
    return '';
}

// Hilfsfunktion: Prüft, ob ein Datastream-Name (shortName) ein Battery Voltage ist
function isBatteryVoltage(shortName) {
    const key = shortName.toLowerCase().replace(/\s/g, '_');
    return key === 'battery_voltage';
}

// --- Hilfsfunktion für Battery Chart ---
function renderBatteryChart(observations = [], title = 'Batterie-Spannung') {
  const container = document.getElementById('chartContainer3');
  const canvas    = document.getElementById('timeseriesChart3');
  if (!container || !canvas) return;

  // Alte Chart-Instanz zerstören
  if (window.tsChart3) {
    window.tsChart3.destroy();
  }

  // Kein Data → ausblenden
  if (observations.length === 0) {
    container.style.display = 'none';
    return;
  } else {
    container.style.display = '';
  }

  const ctx = canvas.getContext('2d');

  // Datenpunkte fürs Time-Scale
  const dataPoints = observations
    .map(o => ({
      x: new Date(o.phenomenonTime),
      y: typeof o.result === 'number'
           ? o.result
           : parseFloat(o.result)
    }))
    .filter(pt => !isNaN(pt.x) && !isNaN(pt.y));

  // Y-Achse Min/Max mit Padding berechnen
  let minY, maxY;
  if (dataPoints.length) {
    const ys    = dataPoints.map(pt => pt.y);
    const min   = Math.min(...ys);
    const max   = Math.max(...ys);
    const range = max - min;
    const pad   = range === 0
      ? (min === 0 ? 0.1 : Math.abs(min) * 0.05)
      : range * 0.1;
    minY = min - pad;
    maxY = max + pad;
  }

  // Chart-Konfiguration
  const chartConfig = {
    type: 'line',
    data: {
      datasets: [{
        label: title,
        data: dataPoints,
        borderColor: '#FFA500',
        backgroundColor: 'rgba(255,165,0,0.10)',
        fill: true,
        pointRadius: 0
      }]
    },
    options: {
      responsive: true,
      plugins: {
        title: { display: true, text: title, font: { size: 16 } },
        legend: { labels: { font: { size: 16 } } } // Schriftgröße für die Legende
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'day' },
          title: { display: true, text: 'Datum', font: { size: 16 } }
        },
        y: {
          title: { display: true, text: 'Spannung (V)', font: { size: 16 } }
          // min/max setzen wir unten nur, wenn definiert
        }
      }
    }
  };

  // min/max nur hinzufügen, wenn berechnet
  if (minY != null) chartConfig.options.scales.y.min = minY;
  if (maxY != null) chartConfig.options.scales.y.max = maxY;

  // Chart erzeugen
  window.tsChart3 = new Chart(ctx, chartConfig);
}

// --- Initialisierung und Hauptfunktion ---
async function main() {
    const locations = await fetchLocations();
    locationsCache = locations;
    // Auswahlbox befüllen
    marinaSelect.innerHTML = '';
    const sortedLocations = locations.sort((a, b) => {
        if (a.anzeigeName === 'Im Jaich, Stadthafen Flensburg') return -1;
        if (b.anzeigeName === 'Im Jaich, Stadthafen Flensburg') return 1;
        return 0;
    });
    sortedLocations.forEach(loc => {
        const opt = document.createElement('option');
        opt.value = loc.id;
        opt.textContent = loc.anzeigeName;
        marinaSelect.appendChild(opt);
    });
    // Keine Marina standardmäßig auswählen
    // const defaultLoc = locations.find(l => l.name === 'Badesteg Reventlou');
    // if (defaultLoc) marinaSelect.value = defaultLoc.id;
    // Marker mit Hover-Tooltip (Thing-Name)
    if (window._soopMarkers) window._soopMarkers.forEach(m => map.removeLayer(m));
    window._soopMarkers = [];
    locations.forEach(loc => {
        const marker = L.marker([loc.lat, loc.lon], {icon: soopRedIcon}).addTo(map);
        marker.bindTooltip(loc.anzeigeName, {permanent: false, direction: 'top'});
        marker.on('click', () => {
            marinaSelect.value = loc.id;
            showMarinaData(loc.id);
        });
        marker.on('mouseover', async () => {
            const datastreams = await fetchDatastreamsAll(loc.id);
            let filteredDatastreams = datastreams.filter(ds => {
                const n = ds.name.toLowerCase();
                if (n.startsWith('latitude') || n.startsWith('longitude')) return false;
                // Battery Voltage nur für Admin
                const dsShortName = ds.name.split('*')[0].trim();
                if (isBatteryVoltage(dsShortName) && !isAdmin) return false;
                // Standardabweichung nur für Admin
                if (dsShortName.toLowerCase() === 'standard_deviation' && !isAdmin) return false;
                return true;
            });
            const lastValues = await Promise.all(filteredDatastreams.map(async ds => {
                const dsShortName = ds.name.split('*')[0].trim();
                const displayName = getDisplayName(dsShortName);
                const unit = getUnit(dsShortName);
                try {
                    const obsResp = await fetch(`${FROST_API}/Datastreams(${ds['@iot.id']})/Observations?$top=1&$orderby=phenomenonTime desc`);
                    if (obsResp.ok) {
                        const obsData = await obsResp.json();
                        if (obsData.value.length > 0) {
                            const obs = obsData.value[0];
                            const dateObj = new Date(obs.phenomenonTime);
                            const dateStr = dateObj.toLocaleDateString('de-DE');
                            const timeStr = dateObj.toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'});
                            return `<div style='margin-bottom:6px;'><span style='font-size:1.28em;font-weight:600;'>${displayName}:</span> <span style='font-size:1.28em;color:#053246;'>${obs.result} ${unit}</span><br><span style='font-size:1.28em;color:#888;'>${dateStr} ${timeStr}</span></div>`;
                        }
                    }
                } catch (e) {}
                return `<div style='margin-bottom:6px;'><span style='font-size:1.08em;font-weight:600;'>${displayName}:</span> <span style='color:#888;'>n/a</span></div>`;
            }));
            const popupHtml = `
                <div style='min-width:210px;padding:4px 2px 2px 2px;'>
                    <div style='font-size:1.58em;font-weight:700;margin-bottom:8px;color:#053246;'>${loc.anzeigeName}</div>
                    ${lastValues.join('')}
                </div>
            `;
            marker.bindPopup(popupHtml, {autoPan: true, closeButton: false, className: 'soop-popup'}).openPopup();
        });
        marker.on('mouseout', () => {
            marker.closePopup();
        });
        window._soopMarkers.push(marker);
    });
    // Graue Marker für zusätzliche Marinas hinzufügen
    const additionalMarinas = [
        { name: 'Marina Heiligenhafen (Demnächst verfügbar)', lat: 54.3755, lon: 10.9845 },
        { name: 'Marina Lübeck "The Newport" (Demnächst verfügbar)', lat: 53.8734, lon: 10.6834 }
    ];

    additionalMarinas.forEach(marina => {
        const grayIcon = new L.Icon({
            iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-grey.png',
            shadowUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-shadow.png',
            iconSize: [25, 41],
            iconAnchor: [12, 41],
            popupAnchor: [1, -34],
            shadowSize: [41, 41]
        });

        const marker = L.marker([marina.lat, marina.lon], { icon: grayIcon }).addTo(map);
        marker.bindTooltip(marina.name, { permanent: false, direction: 'top' });
    });

    // Karte auf Mittelwert der Marinas zentrieren
    if (locations.length > 0) {
        const avgLat = locations.reduce((sum, l) => sum + l.lat, 0) / locations.length;
        const avgLon = locations.reduce((sum, l) => sum + l.lon, 0) / locations.length;
        map.setView([avgLat, avgLon], initialZoom); // Zoomstufe ggf. anpassen
    }
    // Beim Wechsel der Auswahlbox Marina anzeigen
    marinaSelect.onchange = () => {
        showMarinaData(marinaSelect.value);
    };
    // Initial Badesteg Reventlou anzeigen
    // if (defaultLoc) showMarinaData(defaultLoc.id);
    // Admin: Zeige battery_voltage Übersicht
    if (isAdmin) {
        const batteryData = await fetchAllBatteryVoltages(locations);
        showBatteryOverview(batteryData);
    } else {
        hideBatteryOverview();
    }

    // Karte zentrieren und Zoom anpassen, sodass alle Marker sichtbar sind
    function fitMapToMarkers() {
        const allMarkers = [
            ...locationsCache.map(loc => [loc.lat, loc.lon]),
            [54.3755, 10.9845], // Marina Heiligenhafen
            [53.8734, 10.6834]  // Marina Lübeck "The Newport"
        ];

        if (allMarkers.length > 0) {
            const bounds = L.latLngBounds(allMarkers);
            map.fitBounds(bounds, { padding: [20, 20] }); // Padding für etwas Abstand
        }
    }

    // Rufe die Funktion nach dem Hinzufügen der Marker auf
    fitMapToMarkers();
}

// Sicherstellen, dass keine Marina standardmäßig ausgewählt ist
if (marinaSelect) {
    marinaSelect.value = ''; // Setzt die Auswahl auf leer
}

// Event-Listener für die Auswahlbox hinzufügen
marinaSelect.addEventListener('change', (event) => {
    const selectedMarina = event.target.value;
    if (selectedMarina) {
        // Logik für die Auswahl einer Marina hier einfügen
        console.log(`Marina ausgewählt: ${selectedMarina}`);
    }
});
// --- Ursprüngliche showMarinaData wiederherstellen ---
async function showMarinaData(marinaId) {
    const loc = locationsCache.find(l => l.id == marinaId);
    if (!loc) return;

    // Zeige die Tabelle der letzten Messwerte
    renderLastValuesTable(loc);

    // Lade alle Datastreams für das Thing
    const datastreams = await fetchDatastreamsAll(loc.id);

    let filteredDatastreams = datastreams.filter(ds => {
        const n = ds.name.toLowerCase();
        if (n.startsWith('latitude') || n.startsWith('longitude')) return false;

        const dsShortName = ds.name.split('*')[0].trim();
        if (isBatteryVoltage(dsShortName) && !isAdmin) return false;
        if (dsShortName.toLowerCase() === 'standard_deviation' && !isAdmin) return false;

        return true;
    });

    if (!isAdmin) {
        filteredDatastreams = filteredDatastreams.filter(ds => !ds.name.toLowerCase().startsWith('battery_voltage'));
    }

    if (!filteredDatastreams.length) {
        dataTitle.textContent = loc.name + ' (Keine Messdaten)';
        datastreamSelect.innerHTML = '';
        renderChart([], `${loc.name} (Keine Messdaten)`);
        if (window.tsChart2) window.tsChart2.destroy();
        dataSection.scrollIntoView({behavior: 'smooth'});
        return;
    }

    datastreamSelect.innerHTML = '';
    datastreamSelect.multiple = true;
    datastreamSelect.size = Math.min(filteredDatastreams.length, 8);

    const datastreamLabel = document.querySelector('label[for="datastreamSelect"]');
    if (datastreamLabel) datastreamLabel.style.display = 'none';

    filteredDatastreams.forEach(ds => {
        const opt = document.createElement('option');
        opt.value = ds['@iot.id'];
        opt.textContent = ds.name;
        datastreamSelect.appendChild(opt);
    });

    datastreamSelect.style.display = 'none';
    dataTitle.textContent = loc.anzeigeName;

    for (let i = 0; i < datastreamSelect.options.length; i++) {
        datastreamSelect.options[i].selected = true;
    }

    async function updateCharts() {
        const dsTempWater = filteredDatastreams.find(ds => ds.name.toLowerCase().includes('temperature_water'));
        const dsTide = filteredDatastreams.find(ds => ds.name.toLowerCase().includes('tide_measurement'));
        const dsStd = isAdmin ? filteredDatastreams.find(ds => ds.name.toLowerCase().includes('standard_deviation')) : null;
        const dsWave = filteredDatastreams.find(ds => ds.name.toLowerCase().includes('wave_height'));

        // 1. Diagramm: Wassertemperatur
        let obsTemp = [];
        if (dsTempWater) {
            obsTemp = await fetchObservations(dsTempWater['@iot.id'], timeRangeSelect.value);
        }

        if ((!obsTemp || obsTemp.length === 0) && filteredDatastreams.length > 0) {
            const dsWTemp = filteredDatastreams.find(ds => ds.name.toLowerCase().includes('wtemp'));
            if (dsWTemp) {
                obsTemp = await fetchObservations(dsWTemp['@iot.id'], timeRangeSelect.value);
            }
        }

        if (obsTemp && obsTemp.length > 0) {
            renderChart(obsTemp, getDisplayName('temperature_water'));
        } else {
            renderChart([], 'Wassertemperatur (keine Daten)');
        }

        // Zweites Diagramm: Tide, Standardabweichung, Wellenhöhe
        const hasOther = dsTide || dsStd || dsWave;
        const isReventlou = loc.name === 'Badesteg Reventlou' || loc.anzeigeName === 'Badesteg Reventlou';
        const chartContainer2 = document.getElementById('chartContainer2');

        if (isReventlou || !hasOther) {
            if (window.tsChart2) window.tsChart2.destroy();
            if (chartContainer2) chartContainer2.style.display = 'none';
        } else {
            if (chartContainer2) chartContainer2.style.display = '';
            const datasets2 = [];

            if (dsTide) {
                const obsTide = await fetchObservations(dsTide['@iot.id'], timeRangeSelect.value);
                if (obsTide && obsTide.length > 0) {
                    datasets2.push({
                        label: getDisplayName('tide_measurement'),
                        data: obsTide.map(o => ({x: o.phenomenonTime, y: o.result}))
                    });
                }
            }

            if (dsStd && isAdmin) {
                const obsStd = await fetchObservations(dsStd['@iot.id'], timeRangeSelect.value);
                if (obsStd && obsStd.length > 0) {
                    datasets2.push({
                        label: getDisplayName('standard_deviation'),
                        data: obsStd.map(o => ({x: o.phenomenonTime, y: o.result}))
                    });
                }
            }

            if (dsWave) {
                const obsWave = await fetchObservations(dsWave['@iot.id'], timeRangeSelect.value);
                if (obsWave && obsWave.length > 0) {
                    datasets2.push({
                        label: getDisplayName('wave_height'),
                        data: obsWave.map(o => ({x: o.phenomenonTime, y: o.result}))
                    });
                }
            }

            const canvas2 = document.getElementById('timeseriesChart2');
            if (window.tsChart2) window.tsChart2.destroy();

            if (canvas2 && datasets2.length > 0) {
                const colorPalette = ['#78D278', '#FF6666', '#053246'];
                let allLabels = [];
                datasets2.forEach(ds => {
                    allLabels = allLabels.concat(ds.data.map(d => d.x));
                });
                allLabels = Array.from(new Set(allLabels)).sort();

                const chartData2 = {
                    labels: allLabels,
                    datasets: datasets2.map((ds, i) => ({
                        ...ds,
                        borderColor: colorPalette[i % colorPalette.length],
                        backgroundColor: colorPalette[i % colorPalette.length] + '33',
                        fill: false,
                        pointRadius: 0,
                        data: allLabels.map(label => {
                            const found = ds.data.find(d => d.x === label);
                            return found ? found.y : null;
                        })
                    }))
                };

                window.tsChart2 = new Chart(canvas2.getContext('2d'), {
                    type: 'line',
                    data: chartData2,
                    options: {
                        responsive: true,
                        plugins: {
                            title: {
                                display: true,
                                text: 'Wasserstand und Wellenhöhe',
                                font: { size: 16 }
                            },
                            legend: { labels: { font: { size: 16 } } }
                        },
                        scales: {
                            x: {
                                type: 'time',
                                time: { unit: 'day' },
                                title: {
                                    display: true,
                                    text: 'Zeit',
                                    font: { size: 16 }
                                },
                                ticks: {
                                    font: { size: 16 }
                                }
                            },
                            y: {
                                title: {
                                    display: true,
                                    text: 'cm',
                                    font: { size: 16 }
                                },
                                ticks: {
                                    font: { size: 16 }
                                }
                            }
                        }
                    }
                });
            } else if (canvas2) {
                const ctx2 = canvas2.getContext('2d');
                ctx2.clearRect(0, 0, canvas2.width, canvas2.height);
            }
        }
    }

    updateCharts();
    timeRangeSelect.onchange = updateCharts;
    dataSection.scrollIntoView({behavior: 'smooth'});
}
