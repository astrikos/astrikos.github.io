---
title: "Sometimes It's Not Always DNS"
date: 2021-07-16
draft: false
description: "A debugging journey that was triggered by some innocent DNS resolution errors and became a deep dive into Istio’s multi cluster architecture, iptables, conntrack and kernel options."
tags: [Kubernetes, DNS, Istio, Conntrack, Iptables]
---

{{< figure src="/iUrSXtfupWICW5AQNcgbBA.jpeg" >}}

[Beat](https://thebeat.co/en/)’s infrastructure architecture consists of multiple islands that each one of them contains a separate Kubernetes cluster. Recently we took the decision to allow services from different clusters to be able to discover each other. Since we were already using Istio we decided to leverage Istio’s [multi cluster](https://istio.io/latest/docs/setup/install/multicluster/multi-primary/) capability.

After preparing our setup and testing it with some of our home grown tools, we tried to switch one of our lower traffic services to use Istio’s multi cluster discovery. Not long after enabling it, we got reports from some of our fellow engineers that there were some issues with it. Occasionally, services from one cluster were failing to resolve services from a different cluster. The DNS resolution errors were not consistent and were only for endpoints that belong to different clusters.

### **Multi Cluster Istio**

Before jumping into our case, it might be useful to give some background about Istio’s multi cluster architecture. Istio’s multi cluster implementation is heavily based on DNS and a high level idea is given in one of Istio’s [own articles](https://istio.io/latest/blog/2020/dns-proxy/).
Istio is implementing its own DNS proxy in order to serve cross cluster endpoints that are not known to the local cluster resolvers. All DNS requests for each pod are intercepted and served by Istio; if Istio [doesn’t have the answer it redirects the query to the main resolvers](https://github.com/istio/istio/blob/1.9.5/pilot/pkg/dns/dns.go#L160-L226), gets the answer and replies to the client.
But how does Istio redirect DNS traffic destined to the local resolvers found in `/etc/resolver.conf` to its own proxy.

**The answer is _iptables_.**

Istio’s init container sets up several iptables rules. Among those, there are three specific rules in the OUTPUT chain of the NAT table.

```vim
RETURN udp — anywhere anywhere udp dpt:domain owner UID match 1337
RETURN udp — anywhere anywhere udp dpt:domain owner GID match 1337
REDIRECT udp — anywhere 169.254.20.10 udp dpt:domain redir ports 15053
```

The third rule redirects all DNS traffic destined to local resolver (`169.254.20.10`) to localhost in port `15053`, where as we mentioned before Istio proxy DNS listens. The only exception to this rule are the DNS packets that have as user and group ID Istio’s user (rules #1,#2). This is necessary because we don’t want to create an endless loop intercepting Istio’s own DNS requests to the upstream resolvers for endpoints that Istio doesn’t have the answer to.

### **Debugging the Problem**

Now that we have a better idea how the Istio multi cluster feature is supposed to work, let’s continue with our debugging story.

To recap, what we’ve seen so far is that sometimes we see DNS resolution errors in some of our requests towards endpoints that run in different clusters.

The first and easiest step was to [enable](https://github.com/istio/istio/blob/1.9.5/manifests/profiles/default.yaml#L49) [verbose logging](https://istio.io/latest/docs/ops/diagnostic-tools/component-logging/#logging-scopes) in Istio for the DNS part. This allowed us to see DNS questions and answers that Istio was handling. Although the log stream was huge we noticed that the times we see the resolution errors we don’t see any logged requests. That was weird because according to theory (iptables rules), all packets from applications should be redirected to Istio.

* * *

Our next step was to use TCPDUMP to see what kind of packets were flying by in a lower level inside our pods, when we were trying to resolve cross cluster endpoints. Capturing all interfaces from inside our pod we observed that for all the cases that resolution succeeded and everything was fine and dandy we saw similar UDP packets.

```vim {linenos=inline}
15:15:05.386992 IP podA.34250 > localhost.15053: UDP, length 82
15:15:05.387143 IP 169.254.20.10.53 > podA.34250: 43785\*- 1/0/0 A 100.69.6.77 (116)
```

The first packet is the packet that application sends and has traversed through iptables’ NAT table and has been redirected to Istio’s 15053 port. The second packet is the response we get from Istio.

For the cases that resolution failed we saw different packets though.

```vim {linenos=inline}
15:15:06.386980 IP podA.49818 > 169.254.20.10.53: 44588+ A? serviceA.namespaceA.svc.cluster.local. (50)
15:15:05.387099 IP 169.254.20.10.53 > podA.49818: 44588 NXDomain\*- 0/1/1 (154)
```

The first packet which holds the DNS question goes directly to the [nodeLocal DNS](https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/) resolver, and is not redirected to Istio’s DNS port. Since the nodeLocal DNS resolver doesn’t know anything about these cross cluster endpoints, it responds with NXDomain.

So, the NXDOMAIN responses that our applications were seeing now make sense. We don’t actually ask Istio but the local DNS resolver and that is the problem.

That behavior is on par with the logs, so we can rule out the case that we somehow miss logs on the application level.

* * *

_But why are the packets not redirected to localhost 15053? Is something lost in iptables rules?_

A way to see which chain and rule each packet is traversing, is using the logging iptables module.
After adding a logging rule before each rule in the NAT table we saw that in problematic cases we didn’t actually log any packet. That meant that the packet was not entering the OUTPUT chain of NAT tables.
To make sure the packet is traversing any table of iptables and is not lost somewhere else we added a rule on the OUTPUT chain of the RAW table.
According to the figure below every outgoing packet should be visible in the raw table OUTPUT chain.

{{< figure src="/Op2nhVOMLOcFAQtT.png" title="Iptables Flow. Source: https://upload.wikimedia.org/wikipedia/commons/3/37/Netfilter-packet-flow.svg">}}



After we added the logging rule we indeed saw the packet logged and since our mangle iptables table was empty, there was one place left to look next (have you guessed it yet?).

> **Tip #1:**
>
> Since Istio does not allow us to add any iptables rules after pod has started we had to use nsenter and add the rules from the underlying kubernetes host.

> **Tip #2:**
>
> Since the stream of logged packets in the iptables was huge and the output was hard to analyze we only logged packets with specific payload, so we could trace our known “special” queries. You can do that with something like
>
> `sudo nsenter -t 1029090 -n iptables -t nat -I OUTPUT 4 -p udp -m udp — dport 53 -m string — algo bm — hex-string “|706179696e|” -m owner — gid-owner 1337 -j LOG — log-prefix “\[ISTIO-DEBUG-GROUP\]” — log-level 4`
>
> The hex-string can be easily found from the hexadecimal view of the packet in tcpdump.

* * *

What is between RAW and NAT table in iptables for the outgoing packets is of course conntrack.

For UDP cases, conntrack holds a table of known connections (not in the same fashion as in TCP sessions) based on source IP and port and destination IP and port. Inside a pod all the DNS packets had the same destination IP (local DNS resolver) and port (53) and same source IP (pod’s IP). The only variable that was changing was the source’s ephemeral port.

In principle, if conntrack finds a match inside its table, it will skip the NAT table rules and use the redirection strategy that is specified for this “connection”.

To make it more clear let’s see a couple of conntrack entries.

```vim {linenos=inline}
[NEW] udp 17 30 src=100.96.94.222 dst=169.254.20.10 sport=44782 dport=53 [UNREPLIED] src=127.0.0.1 dst=100.96.94.222 sport=15053 dport=44782
[NEW] udp 17 30 src=100.96.94.222 dst=169.254.20.10 sport=41332 dport=53 [UNREPLIED] src=169.254.20.10 dst=100.96.94.222 sport=53 dport=41332
```

The first tuples with (src, dst, sport, dport) are the outgoing packets that create the entry and the second tuple is what is expected as the answer.

The first entry is for a packet that has passed by the DNAT rule, and hence redirected to Istio’s DNS and the second entry is for a packet that goes directly to the local DNS resolver.

You can also see a couple of numbers (17 and 30) in front of each entry. The first is the protocol representation (UDP in our case) and the second one is the time that this entry will be kept inside the conntrack. So if a new packet arrives with the same source IP and port and destination IP and port, it will find a match inside the table and skip the NAT table as the redirection strategy is already known.

At this point, you might have started to suspect what is going on.

Because of our big number of UDP DNS requests, there were a lot of packets created each moment. Some of these packets were using the same source ephemeral port as previous packets. Remember that unlike TCP, where the same ephemeral port can’t _normally_ be used immediately, in UDP we can use it as soon as a packet is sent.

The chances to pick a source ephemeral port that already exists in an entry inside conntrack table are higher with the amount of DNS requests we do; the more DNS requests we produce the more UDP conntrack entries we will have and the probability to pick an ephemeral port that already exists in the conntrack table rises.

Doing some analysis of our traffic with wireshark we saw packets with the same tuples of source IP and port and destination IP and port. And these packets were sent with less than 30seconds difference that is the default conntrack TTL for UDP packets.

{{< figure src="/5cRRQ5TqTfyrrYXz.png" title="DNS packets with same source/destination IP and port">}}

So, packets that were supposed to be redirected to Istio were matching existing conntrack “connections” that had been directed before to local DNS resolver.

_And there was our problem!_

### **Towards The Solution**

One of the first things we tried was to decrease the time that these entries lived inside the conntrack table. The idea was that if we keep UDP "connections" less time in the conntrack table, the chances that we would have similar packets taking the same wrong route decisions would be less.
Adjusting `net.netfilter.nf_conntrack_udp_timeout` and `net.netfilter.nf_conntrack_udp_timeout_stream` kernel options to `1` from their default `30` and `120` respectively helped the situation a bit but not completely solved our problem.\
The downside with this approach is that if a response takes more time than 1 second then we will not be able to find it in the conntrack table and the application might not like the response (due to wrong source IP since NAT-ing was not applied).

Another approach we took was to try to use TCP instead of UDP for our DNS requests. Since there is an [actual TCP port reuse timeout](https://en.wikipedia.org/wiki/Maximum_segment_lifetime) for the ephemeral ports we thought we might see some difference. Indeed we saw a big difference but changing all DNS requests from UDP to TCP was not the easiest solution for us. In order to do that, one can set [use-vc](https://www.man7.org/linux/man-pages/man5/resolv.conf.5.html) in the `etc/resolvers.conf` file; this option though is only respected by systems that use a specific version of glibc standard library. That makes all [alpine images](https://www.alpinelinux.org/posts/Alpine-Linux-has-switched-to-musl-libc.html) that we widely use not compatible.

* * *

Since our attempts to fix the issue weren’t fully satisfactory we reached out to the Istio community and created a detailed [Github issue](https://github.com/istio/istio/issues/33469). One of the maintainers pitched the idea to use conntrack zones to differentiate the traffic. After working together we ended up with a [Github pull request](https://github.com/istio/istio/pull/33572) that was fixing all our issues.\
The idea behind this fix is that we keep two additional (besides the default) conntrack tables. Packets from Istio towards local dns resolver and their responses are using one table, and packets that are initiated by the application and their responses from Istio, are using another table. Having separate tables for each direction allows us to have packets that could have the same source IP and port and destination IP and port, and are still directed in the right destination based on conntrack entries.

The following figure might help you understand more.

{{< figure src="/TlLbcHS_UaMWbW6C.jpg" title="Packet flow using conntrack zones" >}}

This fix addresses our issue and will be included in the next minor Istio [release](https://github.com/istio/istio/releases) (1.11).

### **Concluding**

This started as a normal DNS issue but we had to go deeper and check Istio’s internal, iptables and conntrack zones. We had a great run and learned a lot in the process.

Kubernetes and Istio are great tools and allow us to do things that we would have to spend thousands of hours to implement on our own. They do come through with an increased complexity and sometimes we have to dig deep to get an understanding of how they work.

* * *

> This post was originally published in Beat Engineering Blog, as part of my engineering work at Beat. Cross-posting here for posterity reasons.
>
> [Sometimes It’s Not Always DNS](https://medium.com/taxibeat/sometimes-its-not-always-dns-3c0b6f68f49f)
