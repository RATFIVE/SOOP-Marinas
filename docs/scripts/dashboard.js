// Dashboard-Logik für STA-Datenbank
// 1. Karte initialisieren
// 2. Locations von STA-API laden und Marker setzen
// 3. Beim Klick auf Marker Zeitreihe laden und anzeigen

// Schleswig-Holstein: Mittelpunkt ca. [54.4, 9.7], Zoom 8
const map = L.map('map').setView([54.4, 9.7], 8);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

const FROST_API = 'https://timeseries.geomar.de/soop/FROST-Server/v1.1';

let isAdmin = false;

const popupContainer = document.getElementById('popupContainer');
const closePopup = document.getElementById('closePopup');
const popupTitle = document.getElementById('popupTitle');

// Drag & Drop für das Popup
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

if (popupContainer) {
    popupContainer.addEventListener('mousedown', function(e) {
        // Nur wenn auf den oberen Bereich (nicht auf Inputs etc.) geklickt wird
        if (e.target === popupContainer || e.target === popupTitle) {
            isDragging = true;
            dragOffsetX = e.clientX - popupContainer.getBoundingClientRect().left;
            dragOffsetY = e.clientY - popupContainer.getBoundingClientRect().top;
            popupContainer.style.transition = 'none';
        }
    });
    document.addEventListener('mousemove', function(e) {
        if (isDragging) {
            popupContainer.style.left = (e.clientX - dragOffsetX) + 'px';
            popupContainer.style.top = (e.clientY - dragOffsetY) + 'px';
            popupContainer.style.right = 'auto';
        }
    });
    document.addEventListener('mouseup', function() {
        isDragging = false;
        popupContainer.style.transition = '';
    });
}

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
    const resp = await fetch(`${FROST_API}/Things?$expand=Locations`);
    const data = await resp.json();
    // Things mit Location
    let thingsWithLoc = data.value.filter(thing => thing.Locations && thing.Locations[0] && thing.Locations[0].location && thing.Locations[0].location.coordinates);
    let locations = thingsWithLoc.map(thing => {
        const loc = thing.Locations[0];
        let name = thing.name;
        if (name === 'box_gmr_twl-box_0924005') name = 'Im Jaich, Stadthafen Flensburg';
        if (name === 'box_gmr_twl-box_0924002') name = 'Marina Kappel';
        return {
            id: thing['@iot.id'],
            name: name,
            lat: loc.location.coordinates[1],
            lon: loc.location.coordinates[0]
        };
    });
    // Things ohne Location
    let thingsWithoutLoc = data.value.filter(thing => !thing.Locations || !thing.Locations[0] || !thing.Locations[0].location || !thing.Locations[0].location.coordinates);
    for (const thing of thingsWithoutLoc) {
        // Hole Datastreams
        const dsResp = await fetch(`${FROST_API}/Things(${thing['@iot.id']})/Datastreams`);
        const dsData = await dsResp.json();
        // Suche latitude/longitude Datastreams
        const latStream = dsData.value.find(ds => ds.name && ds.name.toLowerCase().startsWith('latitude'));
        const lonStream = dsData.value.find(ds => ds.name && ds.name.toLowerCase().startsWith('longitude'));
        // Box-Name ggf. ersetzen
        let thingName = thing.name;
        if (thingName === 'box_gmr_twl-box_0924005') thingName = 'Im Jaich, Stadthafen Flensburg';
        if (thingName === 'box_gmr_twl-box_0924002') thingName = 'Marina Kappel';
        if (latStream && lonStream) {
            // Hole letzte Observation für beide
            const latObsResp = await fetch(`${FROST_API}/Datastreams(${latStream['@iot.id']})/Observations?$top=1&$orderby=phenomenonTime desc`);
            const latObsData = await latObsResp.json();
            const lonObsResp = await fetch(`${FROST_API}/Datastreams(${lonStream['@iot.id']})/Observations?$top=1&$orderby=phenomenonTime desc`);
            const lonObsData = await lonObsResp.json();
            if (latObsData.value.length > 0 && lonObsData.value.length > 0) {
                locations.push({
                    id: thing['@iot.id'],
                    name: thingName,
                    lat: latObsData.value[0].result,
                    lon: lonObsData.value[0].result
                });
            }
        }
    }
    let locationsWithRenamed = locations.map(loc => {
        let name = loc.name;
        if (name === 'box_gmr_twl-box_0924005') name = 'Im Jaich, Stadthafen Flensburg';
        if (name === 'box_gmr_twl-box_0924002') name = 'Marina Kappel';
        return {...loc, name};
    });
    return locationsWithRenamed;
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

function renderChart(observations, title = 'Messwert') {
    const ctx = document.getElementById('timeseriesChart').getContext('2d');
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
    const ctx = document.getElementById('timeseriesChart').getContext('2d');
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
const datastreamSelect = document.getElementById('datastreamSelect');
const datastreamSelectContainer = document.getElementById('datastreamSelectContainer');
const timeRangeSelect = document.getElementById('timeRangeSelect');

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
        };
    }
}

if (closePopup) {
    closePopup.onclick = function() {
        popupContainer.style.display = 'none';
        datastreamSelect.innerHTML = '';
        renderChart([], '');
    };
}

async function main() {
    const locations = await fetchLocations();
    // Marker mit Hover-Tooltip (Thing-Name)
    locations.forEach(loc => {
        const marker = L.marker([loc.lat, loc.lon], {icon: soopRedIcon}).addTo(map);
        marker.bindTooltip(loc.name, {permanent: false, direction: 'top'});
        marker.on('click', async () => {
            // Lade alle Datastreams für das Thing
            const datastreams = await fetchDatastreamsAll(loc.id);
            let filteredDatastreams = datastreams;
            // Filter: Keine latitude/longitude-Datastreams im Diagramm
            filteredDatastreams = filteredDatastreams.filter(ds => {
                const n = ds.name.toLowerCase();
                return !n.startsWith('latitude') && !n.startsWith('longitude');
            });
            if (!isAdmin) {
                filteredDatastreams = filteredDatastreams.filter(ds => !ds.name.toLowerCase().startsWith('battery_voltage'));
            }
            if (!filteredDatastreams.length) {
                popupContainer.style.display = 'block';
                popupTitle.textContent = loc.name + ' (Keine Messdaten)';
                datastreamSelect.innerHTML = '';
                renderChart([], `${loc.name} (Keine Messdaten)`);
                return;
            }
            // Multi-Select für Datastreams
            datastreamSelect.innerHTML = '';
            datastreamSelect.multiple = true;
            datastreamSelect.size = Math.min(filteredDatastreams.length, 8);
            filteredDatastreams.forEach(ds => {
                const opt = document.createElement('option');
                opt.value = ds['@iot.id'];
                opt.textContent = ds.name;
                datastreamSelect.appendChild(opt);
            });
            popupContainer.style.display = 'block';
            popupTitle.textContent = loc.name;
            // Initial: alle Datastreams vorauswählen
            for (let i = 0; i < datastreamSelect.options.length; i++) {
                datastreamSelect.options[i].selected = true;
            }
            // Funktion zum Laden und Plotten mehrerer Datastreams
            async function updateMultiChart() {
                const selectedIds = Array.from(datastreamSelect.selectedOptions).map(o => o.value);
                const datasets = [];
                for (const dsId of selectedIds) {
                    const ds = filteredDatastreams.find(d => d['@iot.id'] == dsId);
                    const obs = await fetchObservations(dsId, timeRangeSelect.value);
                    datasets.push({
                        label: ds.name,
                        data: obs.map(o => ({x: o.phenomenonTime, y: o.result})),
                        borderColor: ds.name.toLowerCase().includes('battery') ? '#FF6666' : '#78D278',
                        backgroundColor: ds.name.toLowerCase().includes('battery') ? 'rgba(255,102,102,0.15)' : 'rgba(120,210,120,0.15)',
                        fill: false,
                        pointRadius: 2
                    });
                }
                renderChartMulti(datasets, loc.name);
            }
            // Initial anzeigen
            updateMultiChart();
            // Events für Auswahlwechsel
            datastreamSelect.onchange = updateMultiChart;
            timeRangeSelect.onchange = updateMultiChart;
        });
    });
    // Admin: Zeige battery_voltage Übersicht
    if (isAdmin) {
        const batteryData = await fetchAllBatteryVoltages(locations);
        showBatteryOverview(batteryData);
    } else {
        hideBatteryOverview();
    }
}

main();
