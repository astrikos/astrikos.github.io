var Statistics = function () {
    
    this.asn_activity = {};
    var _this = this

    this.clear_cache = function () {
        _this.asn_activity = {}; 
    };

    this.init = function () {
        setInterval(this.clear_cache, 1800000);       
    }

    this.updateStats = function (message){
        if (this.asn_activity.hasOwnProperty(message.asn)) {
            this.asn_activity[message.asn][0]++;
            if(this.asn_activity[message.asn][1].indexOf(message.prb_id) == -1){
            this.asn_activity[message.asn][1].push(message.prb_id);}
        }
        else {this.asn_activity[message.asn] = [1, [message.prb_id]];}
    };


};
