---
title: "A curious case of AWS NLB timeouts in Kubernetes"
date: 2021-04-13
description: "A debugging adventure that allowed us to solve the tail latencies our Kubernetes applications were experiencing when talking with our AWS NLB."
draft: false
tags: [AWS, Kubernetes, AWS NLB, TCPDUMP]
---

{{< figure src="/xBKI1zezfbGA1gZz.png" >}}

Some time ago [Beat](https://thebeat.co/en/)'s infrastructure team underwent a migration of the flagship service into our Kubernetes clusters and at the time we documented our preparations in a [previous article](https://build.thebeat.co/preparing-before-the-storm-migrating-our-monolith-into-kubernetes-581611c10ae6).

Prior to the migration of the monolith we already had several services inside our Kubernetes cluster, which the monolith and other external services had to reach. The way to do that, was to use ingress controllers with help from [external-dns](https://github.com/kubernetes-sigs/external-dns) to automatically expose microservices to a predefined DNS schema endpoint. Some of these ingress controllers were located behind AWS NLBs, mainly to serve our gRPC traffic.

### **Tail Latencies**

At Beat we have an island architecture where each country we serve has its own infrastructure island and its own Kubernetes cluster. While we tend to keep things local some new services lately need to talk to services in other clusters (cross cluster services). One of these services is communicating using gRPC and is exposed using AWS NLB so services from other clusters can reach it. Besides services from different clusters, we also had services from the **_same_** cluster reaching it using also the very same NLB endpoint. Reaching NLB endpoints from inside the cluster was not by design rather was neglecting our configuration after migrating some services inside our Kubernetes clusters.

At some point we noticed that services from the **_same_** cluster trying to reach the NLB endpoint were getting high latencies for the 99% percentile, known as high [tail latencies](https://en.wikipedia.org/wiki/Long_tail).

{{< figure src="/QX5ydqst91H6c9tw.png" title="High 99th percentile latencies as seen from application using NLB endpoints" >}}

Accessing the same service from **_inside_** the cluster using the native kubernetes DNS schema didn’t have the same results. Everything looked fine.

{{< figure src="/80lWvbml6aKn2_1.png" title="Normal 99th percentile latencies as seen from application when using internal Kubernetes DNS endpoints" >}}

We could have ended our saga there, but our engineering instincts were telling us that something is there, and it might also affect services that use the endpoint from outside the cluster even if we didn’t have proof yet.

The following graph describes the situation we were seeing.

{{< figure src="/WDwu1WzjTcF0keoD.png" title="Latencies based on the different endpoints" >}}

Summarizing, service A from cluster A accessing service B from cluster A using NLB endpoint through ingress controller and NLB was seeing high tail latencies. Service A from cluster A accessing cluster’s A service B using kubernetes native DNS endpoint didn’t see high tail latencies. Service C from cluster B accessing service B using NLB endpoint was also not seeing high latencies.

### **Debugging**

Our first attempt to fix these high latencies was to experiment with several [keepalive options](https://github.com/grpc/grpc/blob/master/doc/keepalive.md#defaults-values) of the gRPC protocol from the application side. Initially, we suspected that NLB was somehow ignoring keepalives and connections were going stale. Unfortunately, none of the combinations we tried made any difference. We were still seeing the same latency issue.

We knew that the problem didn’t exist using the kubernetes DNS endpoint, so that meant that the problem was somewhere between NLB and our ingress controller.

Our next step was to focus on the path from the kubernetes node to AWS NLB.

Since none of our experiments on the application level were fruitful we decided to see what is happening in the network layer from one of our instances using tcpdump. Capturing and examining some traffic we initially noticed that we had several retransmissions of SYN packets.

{{< figure src="/GSQYeXvTx8HJP17r.png" title="Network capture showing TCP SYN packet retransmissions" >}}

Examining several individual TCP streams we observed that each of them was lacking a response.

{{< figure src="/LA5y2LNQ3Uu1Iv6C.png" title="Network capture showing TCP session’s unacknowledged SYN packets" >}}

That meant that we were trying to open TCP connections with the NLB but we didn’t get a SYN-ACK response packet to be able to establish the connection. The weird thing is that we were not seeing any kind of response from the target, for example a RST packet that would help us understand something more.

Observing several performance metrics gathered periodically from our instance didn’t reveal any signs of load or exhaustion of any resource type of the instances. Examining several TCP streams didn’t also show us any low window sizes that would signal a busy TCP buffers from either side.

Using wireshark’s tooling we graphed the retransmitted SYN packets from our instance and we could instantly see some correlation with the latencies that the applications hosted in the machine were seeing.

{{< figure src="/GPPU2Sw4fNc5LhBn.png" title="Wireshark I/O graph of TCP SYN packet retransmissions" >}}

{{< figure src="/zHRt4ka79BtoCwH8.png" title="Latencies seen from application correlated with wireshark I/O graph" >}}

It was obvious that latencies were caused because we could not establish a new connection to the NLB and the application was waiting for some time until it retried with a new connection.

After some further googling we landed in a couple of articles ([\[1\]](https://www.linkedin.com/pulse/connection-optimization-between-nlb-target-groups-romesh-samarakone/), [\[2\]](https://www.niels-ole.com/cloud/aws/linux/2020/10/18/nlb-resets.html)) which didn’t exactly describe what we were experiencing but led us to make a new experiment attempt to disable the “**_preserve client IP_**” flag on our NLB target groups. This flag is enabled by default on Kubernetes AWS NLBs when we create a “_loadbalancer_” type of service and as suggested by the name it makes NLBs to preserve the client’s IP in the connections to its targets.

Magically, this solved all our tail latencies issues; we were not seeing any more latencies and we didn’t have further retransmissions.

### **Mystery unwound**

So, what has happened here? Why did this option fix the retransmissions and latency issue for us?

Reading the same [article](https://www.niels-ole.com/cloud/aws/linux/2020/10/18/nlb-resets.html) once more we were directed to a [specific documentation part of AWS](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-troubleshooting.html#loopback-timeout) which states the following lines:

> Internal load balancers do not support hairpinning or loopback. When you register targets by instance ID, the source IP addresses of clients are preserved. If an instance is a client of an internal load balancer that it’s registered with by instance ID, the connection succeeds only if the request is routed to a different instance. Otherwise, the source and destination IP addresses are the same and the connection times out.

Reading that made us connect the dots and unwound the mystery.

In order for everyone to be able to follow our story we will spend the next paragraph explaining how a Kubernetes Loadbalancer service type works. If you are already familiar with it feel free to skip and go to the next one.

* * *

A [loadbalancer service](https://kubernetes.io/docs/concepts/services-networking/service/#loadbalancer) is basically a [nodeport service](https://kubernetes.io/docs/concepts/services-networking/service/#nodeport) with a loadbalancer attached to all Kubernetes nodes on nodeports’ port. A nodeport service allows a service being reachable via any Kubernetes node at a specific port. Kubernetes (most commonly [kube-proxy](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-proxy/) component) makes sure the packet who will target this port will eventually reach the pod of this service. Being able to use any instance to reach a service makes the loadbalancer implementation in AWS easier since Kubernetes only needs to create an AWS loadbalancer and have all Kubernetes nodes as targets in the target groups at the specific port. Even if the NLB hits an Kubernetes instance that doesn’t contain the service’s pod, kube-proxy will redirect it to the right instance.

* * *

Back to our case, in theory if we try to hit an endpoint associated with our the ingress controller and the NLB **from inside** the Kubernetes cluster there is a chance that our packet will start from an instance A will go to NLB and then directed back to instance A where kube-proxy should direct it to the right destination.

In our case, there were connections initiated from instance A with a certain IP towards the NLB. Considering NLB has the “preserve client IP” option set by default, it would try to create another TCP connection towards the same instance A with the same IP as source and destination address. Following figure tries to depict these rare cases.

{{< figure src="/9xCiq_rnwiC8Z8wM.png" title="Problematic TCP connections from Kubernetes Node to NLB and back" >}}

[AWS’s docs](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-troubleshooting.html#loopback-timeout) describe this situation as “_hairpinning/loopback_” and also states that it’s not supported. As mentioned [here](https://aws.amazon.com/premiumsupport/knowledge-center/target-connection-fails-load-balancer/), the host operating system sees the packet with the same IP as source and destination as invalid and fails to send response traffic, which causes the connection to fail.

Disabling the “_preserve client IP_” flag will cause the source address of the TCP connection to be the one of NLB, so the TCP stream will have different sources and destination addresses. This makes the TCP connection legit and everything works again smoothly.

### **Conclusion**

For this case, the solution for us was to use the internal kubernetes DNS schema where appropriate; internal cluster traffic should not be routed via the NLB, but since we had use cases where we needed to use the NLB for traffic originating from a different cluster, we decided to have a deeper dive to be sure this problem wouldn’t affect similar traffic in the future. We now know that if we want in-cluster traffic going through NLB we just need to disable the “_preserve client IP_” flag. We can achieve this in Kubernetes by adding the following annotation in our service as described in [documentation](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/service/annotations/#traffic-routing).

> service.beta.kubernetes.io/aws-load-balancer-target-group-attributes: preserve\_client\_ip.enabled=false

Using this flag we lose the ability of having the real IP of the client in our logs but we can always get these IPs from NLB’s logs if required and correlate connections.

**Figuring this out has been a great collaboration across domains. Special thanks to Peter Flood from the payments product team.**

As mentioned before, at Beat we strive to look at things in depth when possible and we are not satisfied until we find the root causes of a problem. When we have interesting cases that others might find useful, we try to share in form of blog posts.

Hopefully, this article will save you some hours of debugging.

* * *

> This post was originally published in Beat Engineering Blog, as part of my engineering work at Beat. Cross-posting here for posterity reasons.
>
> [A curious case of AWS NLB timeouts in Kubernetes](https://build.thebeat.co/a-curious-case-of-aws-nlb-timeouts-in-kubernetes-522bd88a3399)
