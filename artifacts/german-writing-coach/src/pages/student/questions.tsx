import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Filter, Clock, Edit3 } from "lucide-react";
import { MOCK_QUESTIONS } from "@/data/mockData";

export default function StudentQuestions() {
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState<string>("All");
  const [, setLocation] = useLocation();

  const filteredQuestions = MOCK_QUESTIONS.filter(q => {
    const matchesSearch = q.title.toLowerCase().includes(search.toLowerCase()) || q.topic.toLowerCase().includes(search.toLowerCase());
    const matchesLevel = levelFilter === "All" || q.level === levelFilter;
    return matchesSearch && matchesLevel && q.active;
  });

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Practice Prompts</h1>
          <p className="text-muted-foreground mt-1">Choose a topic to practice your writing skills.</p>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-4 mb-8">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input 
            placeholder="Search topics..." 
            className="pl-9 bg-card border-border shadow-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          {["All", "A1", "A2"].map(level => (
            <Button 
              key={level}
              variant={levelFilter === level ? "default" : "outline"}
              className="bg-card"
              onClick={() => setLevelFilter(level)}
            >
              {level === "All" ? "All Levels" : level}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Free text card always first */}
        <Card className="border-primary/30 shadow-md bg-gradient-to-br from-card to-primary/5 flex flex-col group hover:shadow-lg transition-all duration-300">
          <CardHeader>
            <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center mb-3">
              <Edit3 className="w-5 h-5 text-primary" />
            </div>
            <CardTitle className="text-xl">Free Writing</CardTitle>
            <CardDescription>Practice without a specific prompt</CardDescription>
          </CardHeader>
          <CardContent className="flex-1">
            <p className="text-sm text-muted-foreground">
              Have something specific in mind? Write about your day, a recent trip, or just paste text you want to check.
            </p>
          </CardContent>
          <CardFooter>
            <Button className="w-full shadow-sm" onClick={() => setLocation("/student/write?mode=free")}>
              Start Free Writing
            </Button>
          </CardFooter>
        </Card>

        {filteredQuestions.map((q, i) => (
          <Card key={q.id} className="flex flex-col group hover:shadow-md transition-all duration-300 animate-in slide-in-from-bottom-4" style={{ animationDelay: `${i * 50}ms` }}>
            <CardHeader className="pb-4">
              <div className="flex justify-between items-start mb-2">
                <Badge variant="secondary" className="bg-secondary text-secondary-foreground">
                  {q.level}
                </Badge>
                <div className="flex items-center text-xs text-muted-foreground bg-muted px-2 py-1 rounded-md">
                  <Clock className="w-3 h-3 mr-1" />
                  {q.estimated_time}
                </div>
              </div>
              <CardTitle className="text-lg line-clamp-2">{q.title}</CardTitle>
              <CardDescription className="text-xs font-medium text-primary">Topic: {q.topic}</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 pb-4">
              <p className="text-sm text-foreground line-clamp-3 mb-4">
                {q.prompt}
              </p>
              <div className="text-xs text-muted-foreground bg-accent/10 text-accent-foreground border border-accent/20 px-3 py-2 rounded-md inline-block">
                Expected: {q.expected_word_range} words
              </div>
            </CardContent>
            <CardFooter>
              <Button variant="outline" className="w-full group-hover:bg-primary group-hover:text-primary-foreground group-hover:border-primary transition-colors" onClick={() => setLocation(`/student/write?q=${q.id}`)}>
                Select Prompt
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
}
