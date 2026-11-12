import java.util.*;
import java.util.concurrent.*;
import java.time.Duration;
import java.nio.charset.StandardCharsets;
import org.apache.kafka.clients.admin.*;
import org.apache.kafka.clients.producer.*;
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.common.*;
import org.apache.kafka.common.serialization.*;

// Fixed teaching adapter. Inputs are bounded and validated by the local Node server.
// JSON output uses only standard Java; the Kafka client comes from the official image.
class Workbench {
  static Properties base() {
    var p = new Properties();
    p.put("bootstrap.servers", "broker1:9092,broker2:9092,broker3:9092");
    p.put("request.timeout.ms", "10000"); p.put("default.api.timeout.ms", "25000");
    p.put("client.id", "kafka-workbench"); return p;
  }
  static String json(Object v) {
    if(v == null) return "null";
    if(v instanceof Number || v instanceof Boolean) return v.toString();
    if(v instanceof Map<?,?> m) return "{" + String.join(",", m.entrySet().stream().map(e -> json(e.getKey().toString())+":"+json(e.getValue())).toList()) + "}";
    if(v instanceof Collection<?> c) return "[" + String.join(",", c.stream().map(Workbench::json).toList()) + "]";
    StringBuilder b = new StringBuilder("\"");
    for(char c : v.toString().toCharArray()) {
      if(c == '"' || c == '\\') b.append('\\').append(c);
      else if(c < 32) b.append(String.format("\\u%04x", (int)c)); else b.append(c);
    }
    return b.append('"').toString();
  }
  static List<Integer> ids(List<Node> nodes) { return nodes.stream().map(Node::id).toList(); }
  static Map<String,Object> record(ConsumerRecord<String,String> r) {
    var m = new LinkedHashMap<String,Object>();
    m.put("partition", r.partition()); m.put("offset", r.offset()); m.put("key", r.key()); m.put("value", r.value()); return m;
  }
  static KafkaConsumer<String,String> consumer(String group, int limit) {
    var p = base(); p.put("group.id", group); p.put("enable.auto.commit", "false");
    p.put("auto.offset.reset", "earliest"); p.put("max.poll.records", ""+limit);
    p.put("key.deserializer", StringDeserializer.class.getName()); p.put("value.deserializer", StringDeserializer.class.getName());
    return new KafkaConsumer<>(p);
  }
  public static void main(String[] a) throws Exception {
    String action=a[0], topic=a[1], group=a[2]; Object output;
    try(var admin=Admin.create(base())) {
      if(action.startsWith("practice-")) {
        output=Practice.execute(admin,action,topic,group);
      } else if(action.equals("prepare")) {
        if(admin.listTopics().names().get().contains(topic)) admin.deleteTopics(List.of(topic)).all().get();
        for(String g : List.of(topic+"-orders", topic+"-audit")) {
          try { admin.deleteConsumerGroups(List.of(g)).all().get(); }
          catch(ExecutionException e) { if(!(e.getCause() instanceof org.apache.kafka.common.errors.GroupIdNotFoundException)) throw e; }
        }
        long deadline=System.currentTimeMillis()+15000;
        while(admin.listTopics().names().get().contains(topic)) {
          if(System.currentTimeMillis()>deadline) throw new IllegalStateException("Topic deletion did not finish"); Thread.sleep(200);
        }
        admin.createTopics(List.of(new NewTopic(topic, Map.of(0,List.of(1,2,3),1,List.of(2,3,1),2,List.of(3,1,2))).configs(Map.of("min.insync.replicas","2")))).all().get();
        output=Map.of("prepared", true);
      } else if(action.equals("snapshot")) {
        var description=admin.describeTopics(List.of(topic)).allTopicNames().get().get(topic);
        var ends=new HashMap<TopicPartition,OffsetSpec>();
        for(var p:description.partitions()) ends.put(new TopicPartition(topic,p.partition()),OffsetSpec.latest());
        var end=admin.listOffsets(ends).all().get();
        Map<TopicPartition,OffsetAndMetadata> committed;
        try { committed=admin.listConsumerGroupOffsets(group).partitionsToOffsetAndMetadata().get(); }
        catch(ExecutionException e) { if(e.getCause() instanceof org.apache.kafka.common.errors.GroupIdNotFoundException) committed=Map.of(); else throw e; }
        var rows=new ArrayList<Object>();
        for(var p:description.partitions()) {
          var tp=new TopicPartition(topic,p.partition()); var c=committed.get(tp); long last=end.get(tp).offset();
          var row=new LinkedHashMap<String,Object>();
          row.put("partition",p.partition()); row.put("leader",p.leader()==null ? -1:p.leader().id());
          row.put("replicas",ids(p.replicas())); row.put("isr",ids(p.isr())); row.put("end",last);
          row.put("committed",c==null ? null:c.offset()); row.put("lag",c==null ? last:last-c.offset()); rows.add(row);
        }
        output=Map.of("partitions",rows,"group",group,"topic",topic);
      } else if(action.equals("produce")) {
        var p=base(); p.put("key.serializer",StringSerializer.class.getName()); p.put("value.serializer",StringSerializer.class.getName());
        p.put("acks","all"); p.put("enable.idempotence","true"); p.put("delivery.timeout.ms","20000");
        var rows=new ArrayList<Object>();
        try(var producer=new KafkaProducer<String,String>(p); var scanner=new Scanner(System.in, StandardCharsets.UTF_8)) {
          while(scanner.hasNextLine()) {
            var parts=scanner.nextLine().split("\\t",-1);
            String key=new String(Base64.getDecoder().decode(parts[1]),StandardCharsets.UTF_8);
            String value=new String(Base64.getDecoder().decode(parts[2]),StandardCharsets.UTF_8);
            var r=producer.send(new ProducerRecord<String,String>(topic,Integer.parseInt(parts[0]),key,value)).get();
            rows.add(Map.of("partition",r.partition(),"offset",r.offset(),"key",key,"value",value));
          }
        }
        output=Map.of("records",rows);
      } else if(action.equals("consume") || action.equals("read-all")) {
        int limit=Integer.parseInt(a[3]); boolean commit=Boolean.parseBoolean(a[4]);
        var rows=new ArrayList<Object>(); var positions=new HashMap<TopicPartition,OffsetAndMetadata>();
        try(var c=consumer(group,limit)) {
          if(action.equals("read-all")) {
            var partitions=List.of(new TopicPartition(topic,0),new TopicPartition(topic,1),new TopicPartition(topic,2));
            c.assign(partitions); c.seekToBeginning(partitions);
          } else c.subscribe(List.of(topic));
          long deadline=System.currentTimeMillis()+12000;
          while(rows.size()<limit && System.currentTimeMillis()<deadline) {
            for(var r:c.poll(Duration.ofMillis(500))) {
              if(rows.size()==limit) break;
              rows.add(record(r)); positions.put(new TopicPartition(topic,r.partition()),new OffsetAndMetadata(r.offset()+1));
            }
          }
          if(commit && !positions.isEmpty()) c.commitSync(positions);
        }
        output=Map.of("records",rows,"committed",commit);
      } else throw new IllegalArgumentException("Unsupported operation");
    }
    System.out.println(json(output));
  }
}
