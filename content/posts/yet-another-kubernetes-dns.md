---
title: "Yet Another Kubernetes DNS Latency Story"
date: 2020-10-15
description: "How introducing Kubernetes node local DNS cache increased our latency towards our upstream resolver."
draft: false
tags: [AWS, DNS, Kubernetes, Kops, TCPDUMP]
---

{{< figure src="/Wc4YXVHskUj1QKqKJR0pfA.png" >}}

In previous Beat articles we talked about [the importance of DNS in our Kubernetes clusters](https://build.thebeat.co/dns-caching-for-kubernetes-fdd89c38c095) and [how we managed to scale through different techniques](https://build.thebeat.co/preparing-before-the-storm-migrating-our-monolith-into-kubernetes-581611c10ae6). We also mentioned that one of the [upcoming versions of Kubernetes](https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/) would provide the ultimate way to handle our DNS problems and give us some peace of mind while working on other parts. At [Beat](https://thebeat.co/en/about-us/?intl=1), we use [kops](https://github.com/kubernetes/kops) to provision and maintain our cluster so we opted on waiting until kops would support it. **The time arrived and kops** [**released**](https://github.com/kubernetes/kops/releases/tag/v1.18.0) **the long awaited feature of NodeLocal DNSCache back in August**, so we didn’t lose the chance to be one the first to try it out.

### **What is NodeLocal DNSCache**

According to the [Kubernetes documentation](https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/) Node Local DNS Cache:

> _improves Cluster DNS performance by running a DNS caching agent on cluster nodes as a DaemonSet._

The DNS caching agent is yet another coreDNS binary that runs in all machines. Through some additional iptables rules the DNS requests of all individual pods of the cluster will get redirected to the local node coreDNS pod that is part of the node local DNS cache daemonset. That makes the migration to the new setup smooth as there is no need for additional changes in the existing pods.

A sample configuration of a coreDNS daemon in a single Kubernetes nodes is:

{{< figure src="/T00zW4q0uIO_rL0DE8uG-A.png" title="CoreDNS configuration deployed as daemonset in every Kubernetes node." >}}

The `force_tcp` flag inside each zone’s configuration will force the local coreDNS to reach the upstream server of each zone using TCP protocol if it doesn’t have a fresh response in its cache.

The overall flow of a DNS request would now be:

{{< figure src="/ekMl3qTfQ84LvTE2Vta95Q.png" title="DNS request flow inside Kubernetes" >}}

Since TCP requires more packets due to its connection-oriented nature, we expected some small increase in the latency of these requests but the advantages seemed to be bigger. The detailed advantages of this new setup are documented nicely in the [Kubernetes documentation](https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/#motivation) page. Especially, if you are using a 4.xx kernel version you will find that this new setup helps reduce the [conntrack races](https://www.weave.works/blog/racy-conntrack-and-dns-lookup-timeouts) that are already [reported](https://github.com/kubernetes/kubernetes/issues/56903). We had recently moved to 5.xx kernel nodes so we didn’t expect to see any differences there.

If you look closer at the latest part of the configuration though, you will notice an interesting choice of directing all the **_non_** Kubernetes related DNS queries through TCP as well. Initially, we were a bit skeptical about this choice but we decided to go with it since that was the default configuration that kops was using.

### **First Impressions**

After we tested the new setup in our testing environments we decided to start enabling the change gradually in our production clusters. After deploying it to one of them the impact to our main coreDNS deployment was immediately visible.

{{< figure src="/1ujJZL9MA9U29meIChHK8Q.png" title="Drop in the latency of CoreDNS requests" >}}

{{< figure src="/OWu00jFYR0o_86AHbOEmZQ.png" title="Drop in the amount of CoreDNS requests" >}}

The latency of the responses decreased dramatically from milliseconds to microseconds; and the same goes for the total number of requests the coreDNS deployment was receiving. Everything seemed to be according to our expectations and the team was very pleased with the results.

Since we wanted to have as small a blast radius as possible, we deployed to a single production cluster on low traffic times and waited for the traffic to pick up gradually and see how the new setup behaves.

### **Increased latencies**

After some time that the traffic had picked up, we started getting alerts from our SLI metrics that our latency error budget is burning too fast. That alarmed us and looking at our graphs we noticed that the majority of our nodes reported high latencies for the 90 and 99 percentiles.

As mentioned in the beginning of this article, we expected the UDP to TCP switch to add some small latency in our requests but what we saw was not what we expected.

{{< figure src="/RVjxi69x_v7V2fA-drN6SA.png" title="NodeLocal DNSCache latency increase in all cluster nodes" >}}

{{< figure src="/zVhxx5uzad1LHR3QA_yKmg.png" title="NodeLocal DNSCache latency percentiles in single node" >}}


We held back the deployments to the rest of the clusters and started looking at the problem. We knew that there were some long debugging sessions in front of us so we rolled up our sleeves and started digging.

### **Debugging**

One of the first steps we took was to understand what kind of requests were taking that long. As mentioned above, we were seeing this behaviour only for our 90 and 99 percentiles and not for all queries. CoreDNS has a handy feature to enable verbose logging that will log every single request that is made towards the pods; so we enabled it in a try to spot any pattern in the requests that were taking longer times.

Unfortunately, we couldn’t spot anything obvious besides verifying that a bunch of queries do take a long time, so we decided to look at lower network levels. We fired a TCPDUMP capturing DNS traffic and we examined the output quickly.

{{< figure src="/6KSUdhpla2NYTIcX7_HdMg.png" title="DNS UDP packet latency (8s)" >}}

As seen in the wireshark output several UDP responses were indeed taking 8 seconds. We had to figure out what was happening in between these 8 seconds. As we described above, the current requests flow was that the application client would talk using UDP to the local caching agent and then the communication with the upstream resolvers would switch to using TCP.

Our gut feeling was telling us that this was related with the “force\_tcp” flag that was introduced, so in order to quickly prove this hypothesis we momentarily removed that flag for the “.” zone and indeed that proved to bring latency back to normal levels.

{{< figure src="/GhyHYUzUfNnBR604FNPTRg.png" title="NodeLocal DNSCache TCP to UDP latency effect" >}}

However, our curious nature and engineering culture to understand things didn’t allow us to claim victory just yet and we continued investigating why TCP had such a different behaviour.

Looking at our node local cache DNS logs we noticed an unusual amount of logs coming in. Instead of having a handful of logs due to various pods restarts we had hundreds of logs per minute. As shown in the next graph all the logs were errors about TCP timeouts towards our upstream server.

{{< figure src="/1xUNw-24J5bO37bBHK5-RA.png" title="NodeLocal DNSCache error logs" >}}

That alerted us and we jumped on the previous TCPDUMP. This time we focused on the part of the TCP connections.

Filtering a specific time frame where we saw a long UDP response, we noticed a lot of retransmissions especially on the initial TCP SYN packets in the communication with our upstream resolvers.

{{< figure src="/B-QcWemiBSJKk8uuPaVn4w.png" title="NodeLocal DNSCache TCP retranmissions" >}}

Having TCP retransmissions is normal and part of how TCP guarantees the packet’s delivery. But having 70+ retransmissions towards a single destination in a 8 seconds time range is not normal for our network.

What initially crossed our minds was that we are rate limited by our upstream provider, which in our case happens to be AWS. [Their documentation](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-dns.html#vpc-dns-limits) states that we have a limit of around 1k packets per second. Analyzing, though, the same TCPDUMP and getting the I/O graph showed us that we were not close to 1k mark.

{{< figure src="/Zhepei8eXeNDVEZkjIUlOw.png" title="NodeLocal DNSCache TCPDUMP I/O graph" >}}

Since we didn’t have access on the destination side to take TCPDUMPs and see how destination sees the same connections, we decided to reach out to our cloud provider support.

After talking with their DNS team we were informed that the latencies we see are indeed a byproduct of using TCP protocol, since there are some limitations when using TCP towards their DNS server.

Their suggestion and guidance is to use UDP, which we had already done but it was relieving to conclude that the latencies were not introduced from inside our platform.

### **Concluding**

At Beat, we cultivate a culture of always looking things in depth and we are not satisfied until we find the root causes of things. Admittedly, this is not always possible, but when we find something that can be useful to the community, we share our learnings through blog posts or contribute back to the open source tools we use daily .

For this case, since we tried the new kops release pretty early, we thought it would only be proper to contribute the `force_tcp` flag change back to the community. We opened [a pull request to kops repository](https://github.com/kubernetes/kops/pull/9917) for that change, which was fast merged and it will be available with the next minor release.

* * *

> This post was originally published in Beat Engineering Blog, as part of my engineering work at Beat. Cross-posting here for posterity reasons.
>
> [Yet another Kubernetes DNS latency story](https://build.thebeat.co/yet-another-kubernetes-dns-latency-story-2a1c00ebbb8d)
