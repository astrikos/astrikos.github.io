var PageView = function (streamManager, stats) {

    var paused = false;

    //var greenIcon = L.icon({
    //    "iconAnchor": [15, 15],
    //    iconUrl: 'https://api.tiles.mapbox.com/v3/marker/circle-s-marker+00FF00.png'
    //});
    //
    //var redIcon = L.icon({
    //    "iconAnchor": [8, 15],
    //    iconUrl: 'https://api.tiles.mapbox.com/v3/marker/circle-s-marker+FF0000.png'
    //});

var map;

var markers = [];

var that = this;

function createMap() {
    map = L.map('map').setView([52.3, 4.9], 9);
    var popup = L.popup();

        // add an OpenStreetMap tile layer
        L.tileLayer('http://{s}.tile.osm.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="http://osm.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map);
    }

    function pauseStream() {
        paused = !paused;
        document.getElementById("pause").innerHTML = paused ? "Start" : "Pause";
        document.getElementById("pause").active = paused;
    }

    this.onMessage = function (message) {
        if (!paused) {
            updateLogsTable(message);
            stats.updateStats(message);
            if (probesLocation.hasOwnProperty(message.prb_id)) {
                displayNewPosition(probesLocation[message.prb_id][0], probesLocation[message.prb_id][1], "Probe ID: " + message.prb_id, message.event);
            }

        }
    };

    function displayNewPosition(lat, lng, body, event) {
        //var icon = event == "connect" ? greenIcon : redIcon;
        var marker;

        marker = L.circleMarker([lat, lng], {
            radius: 4,
            opacity: 1,
            fillOpacity: 1,
            color: (event == "connect") ? "#2FB000" : "#CF0000"
        });
        marker = marker.addTo(map).bindPopup(body);  // add new marker
        markers.push(marker);
    }

    function clearMap() {
        var marker = markers.pop();
        while (marker) {
            map.removeLayer(marker);
            marker = markers.pop();
        }
    }

    function updateStatsTable() {
        // Reset table except headers
        $("#stats-table tbody tr").remove();

        var stats_table = document.getElementById("stats-table").getElementsByTagName('tbody')[0];

        // Sort dict
        var items = Object.keys(stats.asn_activity).map(function(key) {
            return [key, stats.asn_activity[key]];
        });
        items.sort(function(first, second) {
            return second[1][0] - first[1][0];
        });

        //Fill table with sorted data
        for (var i = 0; (i < items.length && i<10); i++) {
            var row = stats_table.insertRow(-1);
            var cell0 = row.insertCell(0);
            cell0.setAttribute("width", "15%");
            cell0.innerHTML = items[i][0]
            var cell1 = row.insertCell(1);
            cell1.setAttribute("width", "15%");
            cell1.innerHTML = items[i][1][0]
            var cell2 = row.insertCell(2);
            cell2.setAttribute("width", "15%");
            cell2.innerHTML = items[i][1][1]
        }
    };

function updateLogsTable(message) {
    var connections = document.getElementById("connections-table");
    var rowCount = connections.rows.length;
    if (rowCount >= 3000) {
        connections.deleteRow(rowCount - 1);
    }
    var row = connections.insertRow(1);
    if (message.event == "connect") {
        row.setAttribute("class", "success");
    }
    else {
        row.setAttribute("class", "danger");
    }

    var cell0 = row.insertCell(0);
    cell0.setAttribute("width", "15%");
    cell0.innerHTML = '<a href="https://atlas.ripe.net/probes/' + message.prb_id + '/" target="_blank">' + message.prb_id + '</a>';

    var cell1 = row.insertCell(1);
    cell1.setAttribute("width", "15%");
    cell1.innerHTML = '<a href="https://stat.ripe.net/' + message.asn + '/" target="_blank">' + message.asn + '</a>';

    var cell2 = row.insertCell(2);
    cell2.setAttribute("width", "15%");
    cell2.innerHTML = '<a href="https://stat.ripe.net/' + message.prefix + '/" target="_blank">' + message.prefix + '</a>';

    var cell3 = row.insertCell(3);
    cell3.setAttribute("width", "15%");
    cell3.innerHTML = message.controller;

    var cell4 = row.insertCell(4);
    cell4.setAttribute("width", "15%");
    var connection_time = moment.unix(message.timestamp).format('MMMM Do, h:mm:ss a');
    cell4.innerHTML = connection_time;

    var cell5 = row.insertCell(5);
    cell5.setAttribute("width", "15%");
    var status = message.event == "connect" ? "Connect" : "Disconnect";
    cell5.innerHTML = status;
}

this.init = function () {
    createMap();
    setInterval(updateStatsTable, 10000);

    $('#pause').click(pauseStream);
    $('#clear-map').click(clearMap);

    $('form').submit(function () {
        clearMap();
        var config = { stream_type: "probestatus" };
        var prbID = $("#prbID").val();
        var asn = $("#asn").val();
        if (prbID) {
            config.prb = prbID;
        }

        if (asn) {
            config.equalsTo = {asn: asn};
        }

        streamManager.setup(config, true, that.onMessage);
        return false;
    });
};
};
