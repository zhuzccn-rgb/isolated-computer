import argparse
import json
from pathlib import Path
import tkinter as tk

parser=argparse.ArgumentParser()
parser.add_argument('--state',required=True)
parser.add_argument('--sentinel',default='')
args=parser.parse_args()
root=tk.Tk()
root.title('Isolated native fixture')
root.geometry('640x400+0+0')
root.configure(bg='#e9f1fc')
entry=tk.Entry(root,font=('sans',18))
entry.place(x=40,y=60,width=240,height=40)
entry.insert(0,args.sentinel)
count=0
dragged=False
wheel=0
key_events=[]
def key_event(event):
 key_events.append({'type':str(event.type),'key':event.keysym})
 del key_events[:-40]
root.bind_all('<KeyPress>',key_event,add='+')
root.bind_all('<KeyRelease>',key_event,add='+')
def scroll(event):
 global wheel
 wheel+=1 if event.num==5 else -1
root.bind_all('<Button-4>',scroll,add='+')
root.bind_all('<Button-5>',scroll,add='+')
def mouse_wheel(event):
 global wheel
 wheel+=1 if event.delta<0 else -1
root.bind_all('<MouseWheel>',mouse_wheel,add='+')
label=tk.Label(root,text='Clicks: 0',font=('sans',18),bg='#e9f1fc')
label.place(x=320,y=120)
def click():
 global count
 count+=1
 label.configure(text=f'Clicks: {count}')
button=tk.Button(root,text='Click',command=click)
button.place(x=40,y=120,width=240,height=50)
canvas=tk.Canvas(root,bg='#4b88ec')
canvas.place(x=40,y=220,width=300,height=100)
def drag(event):
 global dragged
 dragged=True
canvas.bind('<B1-Motion>',drag)
def state():
 data={'text':entry.get(),'clicks':count,'dragged':dragged,'wheel':wheel,'keyEvents':key_events,'focus':str(root.focus_get())}
 temporary=Path(args.state+'.tmp')
 temporary.write_text(json.dumps(data,ensure_ascii=False))
 temporary.replace(args.state)
 root.after(30,state)
root.after(100,lambda:entry.focus_force())
root.after(120,state)
root.mainloop()
