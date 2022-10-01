---
title: "Demystifying Kubernetes networking using TCPDUMP"
date: 2022-06-01
description: "A TCPDUMP trip down the mystical networking areas of Kubernetes and Istio world."
draft: false
tags: [Kubernetes, Istio, TCPDUMP, Iptables]
---


Have you ever wondered how a packet reaches its destination in a Kubernetes environment? How many hops a packet will take before it even “exits” from its Kubernetes node? How do components like [kube-proxy](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-proxy/) and service mesh solutions like [Istio](https://istio.io/) and [Linkerd](https://linkerd.io/) influence the flow of this packet?
One of the best ways to observe packets is of course TCPDUMP. In this article, we will try to demystify Kubernetes and Istio networking behaviours and see in practice how these tools work by using TCP streams from TCPDUMP.

Before we go further with our use cases it makes sense to describe our lab environment. Our Kubernetes cluster is on version `1.21`, it runs kube-proxy in iptables mode and Istio is in `1.13.4` version.

### **Observations from inside a pod**

For our first experiment, we will have a default Nginx installation, which we will use as target; another standalone ubuntu pod will be the source of our packets. Our Nginx Kubernetes service has `10.0.185.118` as IP, the Nginx pod `10.244.4.224` and ubuntu pod will be `10.244.10.89`.

We will start with a simple HTTP `HEAD` request from the ubuntu pod towards the Nginx Kubernetes service. In the ubuntu pod we will run in parallel a TCPDUMP session where we can see the packets flying by.

After doing the HTTP request using `curl` we see the following TCP stream:

{{< gist astrikos 169062c5529470f76d7bdb4ba1257ada >}}
<!-- Tcpdump taken from inside the Pod -->

Let’s dive into what we see here.

The very first four packets are UDP packets and they are the DNS _queries_ and _answers_ that `curl` triggers in order to get the IP of the service we want to target. The next three packets are the standard [TCP 3-way handshake](https://en.wikipedia.org/wiki/Transmission_Control_Protocol#Connection_establishment), the next four packets are the actual packets holding the HTTP information and the last three packets are used for [the TCP connection termination](https://en.wikipedia.org/wiki/Transmission_Control_Protocol#Connection_termination). Nothing really interesting to observe in terms of TCP flow.

### **Observations from inside a Kubernetes Node**

How do we go, though, from the service’s IP (`10.0.185.118`) to the IP assigned to the specific Nginx pod (`10.244.4.224`). In the stream we didn’t see any packet with IP that belongs to the Nginx pod (`10.244.4.224`).

Let’s try to go a level deeper and observe things from the Kubernetes node level.

{{< gist astrikos bf96cc46986d625df05fe6973f4928df >}}
<!-- Tcpdump taken from the Kubernetes node -->

A first easy observation is that every single packet seems to appear four times. Luckily, one of the newest TCPDUMP features allows us to see the interface the packets are coming from. As you can see a single packet traverses four interfaces before leaving the Kubernetes node. Seeing the interfaces in our node using `ip a` we see a couple of dozen interfaces where majority have a `veth*` prefix in their name.

{{< gist astrikos 850cb670f534bca95b08ea6717ceff08 >}}
<!-- Kubernetes node interfaces -->

These are virtual interfaces that most of Kubernetes [CNIs](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/network-plugins/#cni) are creating for each pod that is scheduled in each node. If we also look at the bridges in our node using `brctl show` we see that all of the `veth*` virtual interfaces are part of `cbr0` bridge.

{{< gist astrikos 424fcb6b4bb470c5ab48b5cd512af65b >}}
<!-- Kubernetes node bridges -->

This information is also available in the `ip a` output where it’s specified that the master interface of this virtual interface is `cbr0`. If we see the existing routes using `ip route` in our system we see that `eth0` is used to “exit” the node. The `eth0` and the `enP41291s1` seem also to be paired as we see that `eth0` is stated as master for `enP41291s1`. So now we know that in order for a packet inside a pod to leave the node, it traverses from its virtual interface to the bridge and then to the node’s interfaces `eth0` and `enP41291s1`.

The second observation is that as in the previous stream from inside the pod we see the service’s IP and port.

{{< gist astrikos 3ce65d8a4d9e747042217493841ec743 >}}
<!-- Single TCP packet with service IP -->

Additionally though, in the next packet we see that the destination IP and port have been translated to the pod’s IP and port. What could cause this to happen?

{{< gist astrikos 7a027b4dfbca24f39b4508a7293473c7 >}}
<!-- Single TCP packet with pod IP -->


If you have been working with Kubernetes for some time you should be familiar with one of its core component called [kube-proxy](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-proxy/). Kube-proxy is responsible for doing this translation. In our lab kube-proxy is setup to use iptables, so if we examine the iptables rules inside the Kubernetes node we will see the line below.

{{< gist astrikos 7249bc41a14b6ded7f5d45fb6e306ad3 >}}
<!-- iptables rule for a kubernetes service -->

[Kube-proxy in iptables mode](https://kubernetes.io/docs/concepts/services-networking/service/#ips-and-vips) makes sure that we always have up to date rules that translate service IPs to pods IPs.

### **Istio observations**

Nowadays, running service mesh solutions on top of Kubernetes is something common. Does these solutions make any difference in our TCP streams?

Let’s see…

In our lab we will use Istio but Linkerd should have more or less the same behaviour. We will use again an ubuntu pod and we will target a simple Nginx service in the same Kubernetes namespace, that has Istio enabled so all pods in there have Istio.  
Let’s fire up an HTTP `HEAD` request using `curl` from our ubuntu pod and see the packet flow using TCPDUMP from the Kubernetes node.

{{< gist astrikos 3793a1cece386ff2426ef7cf38dbca87 >}}
<!-- Tcpdump inside Kubernetes node for an Istio injected pod -->

There are several interesting observations that we can do based on the above stream.

The first observation is that we don’t see a packet with service’s IP as destination. Unlike the previous TCP stream from the Kubernetes node, here we see that the first packet in the 3-way handshake part has the pod’s IP as destination. Hence somehow we skip the translation from service IP to Pod IP that kube-proxy provides as explained above.

This could be explained if we know some of Istio’s key features. The first one is that Istio installs its own iptables rules in order to intercept all traffic during the pod initialisation time with the help of `istio-init` container. The iptables rules Istio installs can be found with a simple `kubectl logs <pod-name> -c istio-init`. The second feature is that Istio holds an updated map of all Kubernetes services and their respected endpoints (pods IPs). Anyone can inspect which endpoints `istio-proxy` is aware using `istioctl proxy-config endpoints <pod-name>`. In order to keep this map constantly updated `istio-proxy` container talks constantly with istiod pod. This can be easily observed if you fire up a TCPDUMP and filter packets with port `15012` (Istio’s [configuration port](https://istio.io/latest/docs/ops/deployment/requirements/#ports-used-by-istio) ).  
Knowing these we can understand that when Istio intercepts a packet that has as destination IP the service IP, it starts directly a connection using one of the pod’s IP instead.

A second observation is that we see many more data packets comparing to the streams where we didn’t have any Istio. This is related to the TLS overhead that Istio is adding, as all communication between [Istio pods are over TLS](https://istio.io/latest/docs/concepts/security/#mutual-tls-authentication).

The last observation we have is that we don’t see `FIN` TCP packets to close the connection. It seems we keep the connection open although `curl` has exited and the connection should have been closed.

* * *

Now, our last observation is interesting, so let’s try something additional to get more data. Instead of doing only one request we will fire multiple ones in a span of one minute. Here are the TCP packets we see for couple of individual curl requests while we run our loop of requests.

{{< gist astrikos 172747da4a096c85896c3531ca24ffa9 >}}
<!-- Tcpdump inside node for an Istio injected pod with multiple curl requests -->

Again, there are couple of interesting observations in our last stream.

The first one is that it seems we don’t have new TCP connections with every request. Using plain `curl` from bash in a `while true` loop, one might expected that with each `curl` invocation a new TCP connection would have been created. The above TCP stream though suggests that there is a TCP connection already established and we use that one. This explains also the fact that we didn’t see any `FIN` packets after data packets have finished.

The second observation is that we have streams that go to different destination IPs, which belongs to different pods of our service. So, although DNS returns the service IP, our TCP connections open directly towards different pods of our service. This is another evidence that Istio holds the endpoints for each service locally and use them directly as mentioned before.

Both of our observations suggest the existence of a [connection pooling](https://istio.io/latest/docs/reference/config/networking/destination-rule/#ConnectionPoolSettings-HTTPSettings) that Istio maintains.

While the above TCPDUMP capture was from the node level, let’s double check how things seem from inside the pod, where we can see also see traffic from local interfaces where iptables rules might have not been applied yet.

Let’s see the packets from inside the pod’s network:
{{< gist astrikos 79d4a3279eb1050c2a7447210eb08542 >}}

What we can observe here is that although we see the 3-way handshake packets on the `lo` interface we don’t see them going through the `eth0` interface, which is the one used to exit the pod’s network. It’s also worth noticing that the destination port of the first SYN packet is `15001`, which is the [default istio-proxy listen port](https://istio.io/latest/docs/reference/config/istio.mesh.v1alpha1/).

What really happens is that in order Istio to keep a connection pool transparently from any other container, is intercepting all traffic using iptables and holds its own connections, which are different than the connections main containers are initiating.

### **Wrapping up**

In this article we tried to use an all time favourite tool as TCPDUMP to verify and observe in practice some of the theories and tools around networking in the Kubernetes world. Of course, that was only a small portion of the network use cases we could see in a Kubernetes world, but hopefully after reading this article you will have a better idea of how you can in the future debug and explain network behaviours in Kubernetes.

* * *

> This post was originally published by me in itnext.io medium publication. Cross-posting here for posterity reasons.
>
> [Demystifying Kubernetes networking using TCPDUMP](https://itnext.io/demystifying-kubernetes-networking-using-tcpdump-f760f0fb4967)
