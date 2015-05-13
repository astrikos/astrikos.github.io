var StreamManager = function () {
    var that = this;

    this.disconnect = function () {
        this.socket.disconnect()
    };

    this.setup = function (config, forceNew, callback) {
        var server = "http://atlas-stream.ripe.net";
        var io_config = {path: "/stream/socket.io"};

        if (this.socket){
            that.socket.emit("atlas_unsubscribe", that.lastConfig);
            that.socket.on("atlas_unsubscribed", function(){
                console.log(config);
                that.socket.emit("atlas_subscribe", config);

            });
        } else {
            //Connect
            this.socket = io(server, io_config);
            //Send config
            this.socket.on('connect', function () {
                that.socket.emit("atlas_subscribe", config);
            });
            //Setup callback on messages
            this.socket.on('atlas_probestatus', callback);
        }

        that.lastConfig = config;

        //Logging
        console.log("set config for", config);
    }


};
