// Dashboard-Logik für STA-Datenbank
// 1. Karte initialisieren
// 2. Locations von STA-API laden und Marker setzen
// 3. Beim Klick auf Marker Zeitreihe laden und anzeigen

// Schleswig-Holstein: Mittelpunkt ca. [54.4, 9.7], Zoom 8
const map = L.map('map', {
    zoomControl: false,
    dragging: true,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false
}).setView([54.4, 9.7], 8);
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
        batteryOverview.innerHTML = '<b>Spannung aller Geräte</b><br><div id="batteryList"></div>';
        document.body.appendChild(batteryOverview);
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
            if (thing.name === 'box_gmr_twl-box_0924002') anzeigeName = 'Marina Kappel';
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
        from = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    } else {
        from = null;
    }
    return from ? from.toISOString() : null;
}

async function fetchObservations(datastreamId, timeRange) {
    let url = `${FROST_API}/Datastreams(${datastreamId})/Observations?$top=1000&$orderby=phenomenonTime asc`;
    const from = getTimeFilter(timeRange);
    if (from) {
        url += `&$filter=phenomenonTime ge ${from}`;
    }
    const resp = await fetch(url);
    const data = await resp.json();
    return data.value;
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

function renderChart(observations, title = 'Messwert') {
    const canvas = ensureTimeseriesCanvas();
    if (!canvas) {
        console.error('Canvas für Chart nicht gefunden!');
        return;
    }
    const ctx = canvas.getContext('2d');
    if (window.tsChart) window.tsChart.destroy();
    window.tsChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: observations.map(o => o.phenomenonTime),
            datasets: [{
                label: title,
                data: observations.map(o => o.result),
                borderColor: '#78D278', // SOOP-GRÜN
                backgroundColor: 'rgba(120,210,120,0.15)', // SOOP-GRÜN transparent
                fill: true,
                pointRadius: 2
            }]
        },
        options: {
            responsive: true,
            plugins: {
                title: {
                    display: true,
                    text: title
                }
            },
            scales: {
                x: { type: 'time', time: { unit: 'day' } },
                y: { beginAtZero: true }
            }
        }
    });
}

// Neue Funktion für Multi-Liniendiagramm
function renderChartMulti(datasets, title = 'Messwerte') {
    const canvas = ensureTimeseriesCanvas();
    if (!canvas) {
        console.error('Canvas für Chart nicht gefunden!');
        return;
    }
    const ctx = canvas.getContext('2d');
    if (window.tsChart) window.tsChart.destroy();
    // Farben für die Linien
    const colorPalette = [
        '#78D278', // SOOP-Grün
        '#FF6666', // SOOP-Rot
        '#053246', // SOOP-Blau
        '#FFA500', // Orange
        '#8A2BE2', // Lila
        '#00BFFF', // Hellblau
        '#FFD700', // Gelb
        '#FF69B4', // Pink
        '#A0522D', // Braun
        '#20B2AA'  // Türkis
    ];
    // Hilfsfunktion für Legenden-Label: nur bis zum ersten * anzeigen
    function shortLabel(name) {
        return name.split('*')[0].trim();
    }
    // X-Achse: alle Zeitpunkte aus allen Datastreams sammeln und sortieren
    let allLabels = [];
    datasets.forEach(ds => {
        allLabels = allLabels.concat(ds.data.map(d => d.x));
    });
    allLabels = Array.from(new Set(allLabels)).sort();
    // Für Chart.js: labels und datasets synchronisieren
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
                    text: title
                }
            },
            scales: {
                x: { type: 'time', time: { unit: 'day' }, title: { display: true, text: 'Zeit' } },
                y: { beginAtZero: true, title: { display: true, text: 'Messwert' } }
            }
        }
    });
}

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
            setTimeout(async () => {
                loginBox.style.display = 'none';
                showLogoutButton();
                // Admin: Zeige battery_voltage Übersicht
                const locations = await fetchLocations();
                const batteryData = await fetchAllBatteryVoltages(locations);
                showBatteryOverview(batteryData);
            }, 1000);
            isAdmin = true;
        } else {
            loginStatus.textContent = 'Login fehlgeschlagen!';
            loginStatus.style.color = 'red';
        }
    };
}

// Bereich unter der Karte initial leeren
window.addEventListener('DOMContentLoaded', () => {
    if (dataTitle) dataTitle.textContent = '';
    if (chartContainer) chartContainer.innerHTML = '';
    // Starte main explizit nach DOM-Load
    main();
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
        return true;
    });
    if (!filteredDatastreams.length) return;
    // Hole für jeden Datastream die letzte Observation
    const lastValues = await Promise.all(filteredDatastreams.map(async ds => {
        const dsShortName = ds.name.split('*')[0].trim();
        const displayName = getDisplayName(dsShortName);
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
                        date: dateStr,
                        time: timeStr
                    };
                }
            }
        } catch (e) {}
        return {
            name: displayName,
            value: 'n/a',
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
        html += `<td style='padding:6px 8px;text-align:right;color:#053246;font-weight:600;'>${row.value}</td>`;
        html += `<td style='padding:6px 8px;text-align:center;color:#888;'>${row.date}</td>`;
        html += `<td style='padding:6px 8px;text-align:center;color:#888;'>${row.time}</td>`;
        html += `</tr>`;
    });
    html += `</tbody></table>`;
    lastValuesTableContainer.innerHTML = html;
    lastValuesTableContainer.style.display = 'block';
}

// Wetterdaten von Open-Meteo API holen
// Wetterdaten-Cache für die Session
// const weatherCache = {};

// async function fetchWeatherData(lat, lon) {
//     const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
//     if (weatherCache[key]) {
//         return weatherCache[key];
//     }
//     // Open-Meteo API: https://open-meteo.com/
//     // Wir holen aktuelle Werte für windspeed_10m, temperature_2m, winddirection_10m, pressure_msl
//     const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=temperature_2m,pressure_msl,winddirection_10m,windspeed_10m&timezone=auto`;
//     try {
//         const resp = await fetch(url);
//         if (!resp.ok) return null;
//         const data = await resp.json();
//         if (!data.current_weather) return null;
//         const weather = {
//             windspeed: data.current_weather.windspeed,
//             winddirection: data.current_weather.winddirection,
//             temperature: data.current_weather.temperature,
//             pressure: data.current_weather.pressure_msl || (data.hourly && data.hourly.pressure_msl ? data.hourly.pressure_msl[0] : null),
//             time: data.current_weather.time
//         };
//         weatherCache[key] = weather;
//         return weather;
//     } catch (e) {
//         return null;
//     }
// }

// Wetterdaten in der Tabelle anzeigen (unterhalb der FROST-Messwerte)
// async function renderWeatherTable(loc) {
//     if (!loc || !loc.lat || !loc.lon) return;
//     const weather = await fetchWeatherData(loc.lat, loc.lon);
//     let html = `<div style='font-size:1.08em;font-weight:700;margin-bottom:10px;color:#053246;'>Aktuelle Wetterdaten</div>`;
//     if (!weather) {
//         html += `<div style='color:#888;'>Keine Wetterdaten verfügbar</div>`;
//     } else {
//         const dateObj = new Date(weather.time);
//         const dateStr = dateObj.toLocaleDateString('de-DE');
//         const timeStr = dateObj.toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'});
//         html += `<table style='width:100%;border-collapse:collapse;margin-bottom:8px;'>`;
//         html += `<thead><tr style='background:#f5f5f5;'><th style='text-align:left;padding:6px 8px;'>Parameter</th><th style='text-align:right;padding:6px 8px;'>Wert</th><th style='text-align:center;padding:6px 8px;'>Datum</th><th style='text-align:center;padding:6px 8px;'>Uhrzeit</th></tr></thead>`;
//         html += `<tbody>`;
//         html += `<tr><td style='padding:6px 8px;'>${getDisplayName('temperature')}</td><td style='padding:6px 8px;text-align:right;'>${weather.temperature} °C</td><td style='padding:6px 8px;text-align:center;color:#888;'>${dateStr}</td><td style='padding:6px 8px;text-align:center;color:#888;'>${timeStr}</td></tr>`;
//         html += `<tr><td style='padding:6px 8px;'>${getDisplayName('windspeed')}</td><td style='padding:6px 8px;text-align:right;'>${weather.windspeed} km/h</td><td style='padding:6px 8px;text-align:center;color:#888;'>${dateStr}</td><td style='padding:6px 8px;text-align:center;color:#888;'>${timeStr}</td></tr>`;
//         html += `<tr><td style='padding:6px 8px;'>${getDisplayName('winddirection')}</td><td style='padding:6px 8px;text-align:right;'>${weather.winddirection}°</td><td style='padding:6px 8px;text-align:center;color:#888;'>${dateStr}</td><td style='padding:6px 8px;text-align:center;color:#888;'>${timeStr}</td></tr>`;
//         html += `<tr><td style='padding:6px 8px;'>${getDisplayName('pressure')}</td><td style='padding:6px 8px;text-align:right;'>${weather.pressure ? weather.pressure + ' hPa' : 'n/a'}</td><td style='padding:6px 8px;text-align:center;color:#888;'>${dateStr}</td><td style='padding:6px 8px;text-align:center;color:#888;'>${timeStr}</td></tr>`;
//         html += `</tbody></table>`;
//     }
//     // Wetterdaten unter die FROST-Tabelle einfügen
//     const lastValuesTableContainer = document.getElementById('lastValuesTableContainer');
//     if (lastValuesTableContainer) {
//         let weatherDiv = document.getElementById('weatherTableContainer');
//         if (!weatherDiv) {
//             weatherDiv = document.createElement('div');
//             weatherDiv.id = 'weatherTableContainer';
//             lastValuesTableContainer.appendChild(weatherDiv);
//         }
//         weatherDiv.innerHTML = html;
//     }
// }

// Mapping für sprechende Namen
const DISPLAY_NAME_MAP = {
    'battery_voltage': 'Battery Voltage',
    'temperature': 'Temperature',
    'temperature_water': 'Water Temperature',
    'wtemp': 'Water Temperature',
    'tide_measurement': 'Water Level',
    'water_level': 'Water Level',
    'standard_deviation': 'Standard Deviation Water Level',
    'wave_height': 'Wave Height',
    'windspeed': 'Wind Speed',
    'winddirection': 'Wind Direction',
    'pressure': 'Air Pressure',
    'lufttemperatur': 'Air Temperature',
    // weitere Zuordnungen nach Bedarf
};
function getDisplayName(shortName) {
    const key = shortName.toLowerCase().replace(/\s/g, '_');
    if (DISPLAY_NAME_MAP[key]) return DISPLAY_NAME_MAP[key];
    return shortName.charAt(0).toUpperCase() + shortName.slice(1);
}

// Hilfsfunktion: Prüft, ob ein Datastream-Name (shortName) ein Battery Voltage ist
function isBatteryVoltage(shortName) {
    const key = shortName.toLowerCase().replace(/\s/g, '_');
    return key === 'battery_voltage';
}

// Hauptfunktion
async function main() {
    const locations = await fetchLocations();
    locationsCache = locations;
    // Auswahlbox befüllen
    marinaSelect.innerHTML = '';
    locations.forEach(loc => {
        const opt = document.createElement('option');
        opt.value = loc.id;
        opt.textContent = loc.anzeigeName;
        marinaSelect.appendChild(opt);
    });
    // Standard: Badesteg Reventlou auswählen
    const defaultLoc = locations.find(l => l.name === 'Badesteg Reventlou');
    if (defaultLoc) marinaSelect.value = defaultLoc.id;
    // Marker mit Hover-Tooltip (Thing-Name)
    locations.forEach(loc => {
        const marker = L.marker([loc.lat, loc.lon], {icon: soopRedIcon}).addTo(map);
        marker.bindTooltip(loc.anzeigeName, {permanent: false, direction: 'top'});
        marker.on('click', () => {
            marinaSelect.value = loc.id;
            showMarinaData(loc.id);
        });
        // Hover: Zeige Name und letzte Messungen im Tooltip/Popup
        marker.on('mouseover', async () => {
            const datastreams = await fetchDatastreamsAll(loc.id);
            let filteredDatastreams = datastreams.filter(ds => {
                const n = ds.name.toLowerCase();
                if (n.startsWith('latitude') || n.startsWith('longitude')) return false;
                // Battery Voltage nur für Admin
                const dsShortName = ds.name.split('*')[0].trim();
                if (isBatteryVoltage(dsShortName) && !isAdmin) return false;
                return true;
            });
            const lastValues = await Promise.all(filteredDatastreams.map(async ds => {
                const dsShortName = ds.name.split('*')[0].trim();
                const displayName = getDisplayName(dsShortName);
                try {
                    const obsResp = await fetch(`${FROST_API}/Datastreams(${ds['@iot.id']})/Observations?$top=1&$orderby=phenomenonTime desc`);
                    if (obsResp.ok) {
                        const obsData = await obsResp.json();
                        if (obsData.value.length > 0) {
                            const obs = obsData.value[0];
                            // Datum und Uhrzeit schön formatieren
                            const dateObj = new Date(obs.phenomenonTime);
                            const dateStr = dateObj.toLocaleDateString('de-DE');
                            const timeStr = dateObj.toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'});
                            return `<div style='margin-bottom:6px;'><span style='font-weight:600;'>${displayName}:</span> <span style='color:#053246;'>${obs.result}</span><br><span style='font-size:0.92em;color:#888;'>${dateStr} ${timeStr}</span></div>`;
                        }
                    }
                } catch (e) {}
                return `<div style='margin-bottom:6px;'><span style='font-weight:600;'>${displayName}:</span> <span style='color:#888;'>n/a</span></div>`;
            }));
            const popupHtml = `
                <div style='min-width:210px;padding:4px 2px 2px 2px;'>
                    <div style='font-size:1.08em;font-weight:700;margin-bottom:8px;color:#053246;'>${loc.anzeigeName}</div>
                    ${lastValues.join('')}
                </div>
            `;
            marker.bindPopup(popupHtml, {autoPan: false, closeButton: false, className: 'soop-popup'}).openPopup();
        });
        marker.on('mouseout', () => {
            marker.closePopup();
        });
    });
    // Beim Wechsel der Auswahlbox Marina anzeigen
    marinaSelect.onchange = () => {
        showMarinaData(marinaSelect.value);
    };
    // Initial Badesteg Reventlou anzeigen
    if (defaultLoc) showMarinaData(defaultLoc.id);
    // Admin: Zeige battery_voltage Übersicht
    if (isAdmin) {
        const batteryData = await fetchAllBatteryVoltages(locations);
        showBatteryOverview(batteryData);
    } else {
        hideBatteryOverview();
    }
}

async function showMarinaData(marinaId) {
    const loc = locationsCache.find(l => l.id == marinaId);
    if (!loc) return;
    // Zeige die Tabelle der letzten Messwerte
    renderLastValuesTable(loc);
    // Zeige Wetterdaten
    // renderWeatherTable(loc);
    // Lade alle Datastreams für das Thing
    const datastreams = await fetchDatastreamsAll(loc.id);
    let filteredDatastreams = datastreams.filter(ds => {
        const n = ds.name.toLowerCase();
        if (n.startsWith('latitude') || n.startsWith('longitude')) return false;
        // Battery Voltage nur für Admin
        const dsShortName = ds.name.split('*')[0].trim();
        if (isBatteryVoltage(dsShortName) && !isAdmin) return false;
        return true;
    });
    if (!isAdmin) {
        filteredDatastreams = filteredDatastreams.filter(ds => !ds.name.toLowerCase().startsWith('battery_voltage'));
    }
    if (!filteredDatastreams.length) {
        dataTitle.textContent = loc.name + ' (Keine Messdaten)';
        datastreamSelect.innerHTML = '';
        renderChart([], `${loc.name} (Keine Messdaten)`);
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
    async function updateMultiChart() {
        const selectedIds = Array.from(datastreamSelect.selectedOptions).map(o => o.value);
        const datasets = [];
        for (const dsId of selectedIds) {
            const ds = filteredDatastreams.find(d => d['@iot.id'] == dsId);
            const obs = await fetchObservations(dsId, timeRangeSelect.value);
            // Fehlerbehandlung und Logging für Debug
            if (!obs || obs.length === 0) {
                console.warn('Keine Observations für Datastream', ds ? ds.name : dsId);
            }
            // Nur hinzufügen, wenn Daten vorhanden
            if (obs && obs.length > 0) {
                datasets.push({
                    label: ds.name,
                    data: obs.map(o => ({x: o.phenomenonTime, y: o.result})),
                    borderColor: ds.name.toLowerCase().includes('battery') ? '#FF6666' : '#78D278',
                    backgroundColor: ds.name.toLowerCase().includes('battery') ? 'rgba(255,102,102,0.15)' : 'rgba(120,210,120,0.15)',
                    fill: false,
                    pointRadius: 2
                });
            }
        }
        if (datasets.length === 0) {
            renderChart([], loc.anzeigeName + ' (Keine Messdaten)');
        } else {
            renderChartMulti(datasets, loc.anzeigeName);
        }
    }
    updateMultiChart();
    datastreamSelect.onchange = updateMultiChart;
    timeRangeSelect.onchange = updateMultiChart;
    dataSection.scrollIntoView({behavior: 'smooth'});
}

// Neue Admin-Logik für die Anzeige der battery_voltage Übersicht
function showLogoutButton() {
    let logoutBtn = document.getElementById('logoutBtn');
    if (!logoutBtn) {
        logoutBtn = document.createElement('button');
        logoutBtn.id = 'logoutBtn';
        logoutBtn.textContent = 'Logout';
        logoutBtn.style.position = 'absolute';
        logoutBtn.style.top = '20px';
        logoutBtn.style.right = '30px';
        logoutBtn.style.zIndex = 2001;
        logoutBtn.style.background = '#fff';
        logoutBtn.style.border = '1px solid #0074D9';
        logoutBtn.style.color = '#0074D9';
        logoutBtn.style.padding = '6px 16px';
        logoutBtn.style.borderRadius = '8px';
        logoutBtn.style.cursor = 'pointer';
        document.body.appendChild(logoutBtn);
        logoutBtn.onclick = function() {
            isAdmin = false;
            logoutBtn.remove();
            loginBox.style.display = 'flex';
            datastreamSelect.innerHTML = '';
            datastreamSelectContainer.style.display = 'none';
            renderChart([], '');
            hideBatteryOverview(); // Fenster mit der Spannung aller Geräte schließen
            // Nach Logout: Auswahlbox und Marker neu laden (ohne Admin-Things)
            main();
        };
    }
}
