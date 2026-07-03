import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Search, Plus, Trash2, Edit } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MOCK_QUESTIONS } from "@/data/mockData";
import { Question } from "@/types";

export default function TeacherQuestions() {
  const [questions, setQuestions] = useState<Question[]>(MOCK_QUESTIONS);
  const [search, setSearch] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);

  // Form state
  const [formData, setFormData] = useState<Partial<Question>>({
    title: "", level: "A1", topic: "", prompt: "", expected_word_range: "", estimated_time: "", active: true
  });

  const filteredQuestions = questions.filter(q => 
    q.title.toLowerCase().includes(search.toLowerCase()) || 
    q.topic.toLowerCase().includes(search.toLowerCase())
  );

  const handleOpenDialog = (q?: Question) => {
    if (q) {
      setEditingQuestion(q);
      setFormData({ ...q });
    } else {
      setEditingQuestion(null);
      setFormData({ title: "", level: "A1", topic: "", prompt: "", expected_word_range: "", estimated_time: "", active: true });
    }
    setIsDialogOpen(true);
  };

  const handleSave = () => {
    if (editingQuestion) {
      setQuestions(prev => prev.map(q => q.id === editingQuestion.id ? { ...q, ...formData } as Question : q));
    } else {
      const newQ: Question = { ...formData, id: `q${Date.now()}` } as Question;
      setQuestions([...questions, newQ]);
    }
    setIsDialogOpen(false);
  };

  const handleDelete = (id: string) => {
    setQuestions(prev => prev.filter(q => q.id !== id));
  };

  const toggleActive = (id: string, current: boolean) => {
    setQuestions(prev => prev.map(q => q.id === id ? { ...q, active: !current } : q));
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Question Bank</h1>
          <p className="text-muted-foreground mt-1">Manage writing prompts for your students.</p>
        </div>
        <Button onClick={() => handleOpenDialog()} className="shadow-md">
          <Plus className="w-4 h-4 mr-2" />
          Create Prompt
        </Button>
      </div>

      <div className="mb-6 relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input 
          placeholder="Search prompts..." 
          className="pl-9 bg-card"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredQuestions.map((q, i) => (
          <Card key={q.id} className={`flex flex-col ${!q.active && "opacity-60"} transition-all animate-in slide-in-from-bottom-4`} style={{ animationDelay: `${i * 50}ms` }}>
            <CardHeader className="pb-3">
              <div className="flex justify-between items-start mb-2">
                <Badge variant="outline" className={q.level === "A1" ? "border-green-300 text-green-700 bg-green-50" : "border-blue-300 text-blue-700 bg-blue-50"}>
                  {q.level}
                </Badge>
                <div className="flex items-center gap-2">
                  <Switch checked={q.active} onCheckedChange={() => toggleActive(q.id, q.active)} />
                </div>
              </div>
              <CardTitle className="text-lg line-clamp-1" title={q.title}>{q.title}</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 pb-4">
              <p className="text-xs text-primary font-medium mb-2">Topic: {q.topic}</p>
              <p className="text-sm text-foreground line-clamp-3 mb-3">{q.prompt}</p>
              <div className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded inline-block">
                {q.expected_word_range} words • ~{q.estimated_time}
              </div>
            </CardContent>
            <CardFooter className="border-t border-border pt-4 bg-muted/10 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => handleOpenDialog(q)}>
                <Edit className="w-4 h-4 mr-2" /> Edit
              </Button>
              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(q.id)}>
                <Trash2 className="w-4 h-4" />
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>{editingQuestion ? "Edit Prompt" : "Create New Prompt"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label className="text-right">Title</Label>
              <Input 
                className="col-span-3" 
                value={formData.title} 
                onChange={e => setFormData({...formData, title: e.target.value})} 
                placeholder="e.g. Einladung zur Party" 
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label className="text-right">Level</Label>
              <Select value={formData.level} onValueChange={(val: any) => setFormData({...formData, level: val})}>
                <SelectTrigger className="col-span-3">
                  <SelectValue placeholder="Select level" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="A1">A1</SelectItem>
                  <SelectItem value="A2">A2</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label className="text-right">Topic</Label>
              <Input 
                className="col-span-3" 
                value={formData.topic} 
                onChange={e => setFormData({...formData, topic: e.target.value})} 
                placeholder="e.g. Einladung, Alltag" 
              />
            </div>
            <div className="grid grid-cols-4 items-start gap-4">
              <Label className="text-right mt-2">Prompt</Label>
              <Textarea 
                className="col-span-3" 
                value={formData.prompt} 
                onChange={e => setFormData({...formData, prompt: e.target.value})} 
                placeholder="Schreiben Sie..." 
                rows={4}
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label className="text-right">Word Range</Label>
              <Input 
                className="col-span-3" 
                value={formData.expected_word_range} 
                onChange={e => setFormData({...formData, expected_word_range: e.target.value})} 
                placeholder="e.g. 30-50" 
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label className="text-right">Est. Time</Label>
              <Input 
                className="col-span-3" 
                value={formData.estimated_time} 
                onChange={e => setFormData({...formData, estimated_time: e.target.value})} 
                placeholder="e.g. 10 mins" 
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave}>Save Prompt</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
